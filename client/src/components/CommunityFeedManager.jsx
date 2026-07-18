import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

// Engage → Community: Howler-native communities + feed posts, managed in Pulse
// and served straight to the Howler app (the Social+ replacement spike).
// Dual-surface (scope: 'my' | 'admin'), same component. Contract:
// docs/specs/SOCIAL_CONTRACT.md. Mobile-first: one column, everything stacks.

const VIS = { public: '🌍 Public', members: '🎟 Members only' };
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export default function CommunityFeedManager({ entityId, scope = 'my' }) {
  const [communities, setCommunities] = useState(null);
  const [posts, setPosts] = useState(null);
  const [showCommunityForm, setShowCommunityForm] = useState(false);
  const [error, setError] = useState('');

  const load = () => Promise.all([
    api.socialCommunities(scope, entityId).then((r) => setCommunities(r.communities || [])),
    api.socialPosts(scope, entityId).then((r) => setPosts(r.posts || [])),
  ]).catch(() => { setCommunities((c) => c || []); setPosts((p) => p || []); });
  useEffect(() => { setCommunities(null); setPosts(null); load(); }, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = (fn) => fn.then(() => { setError(''); return load(); }).catch((e) => setError(e.message || 'That didn’t work'));

  if (communities === null || posts === null) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {error && <p style={{ color: '#c62828', fontSize: 13, margin: 0 }}>{error}</p>}

      {/* ── Communities ── */}
      <section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 750 }}>Communities</h3>
          <button style={mini} onClick={() => setShowCommunityForm((v) => !v)}>{showCommunityForm ? 'Close' : '+ New community'}</button>
        </div>
        {communities.length === 0 && !showCommunityForm && (
          <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>No communities yet — start with one for your brand, then add one per event.</p>
        )}
        {showCommunityForm && (
          <CommunityForm
            communities={communities}
            onCreate={(body) => act(api.socialCreateCommunity(scope, entityId, body)).then(() => setShowCommunityForm(false))}
          />
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {communities.map((c) => (
            <div key={c.id} style={{ ...card, marginBottom: 0, display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 180 }}>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 14 }}>
                  {c.type === 'event' ? '🎪' : '🏟'} {c.name}
                  {c.status === 'archived' && <span style={pill('rgba(128,128,128,0.16)', 'var(--muted)')}>archived</span>}
                </p>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}>
                  {c.type === 'event' ? `Event ${c.eventId}` : 'Organiser community'} · {VIS[c.visibility]} · {c.memberCount} member{c.memberCount === 1 ? '' : 's'}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Composer + feed ── */}
      <section>
        <h3 style={{ margin: '0 0 10px', fontSize: 15, fontWeight: 750 }}>Posts</h3>
        {communities.length === 0
          ? <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>Create a community first, then post to it.</p>
          : <Composer communities={communities} onCreate={(body) => act(api.socialCreatePost(scope, entityId, body))} scope={scope} entityId={entityId} />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
          {posts.map((p) => (
            <div key={p.id} style={{ ...card, marginBottom: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
                  {p.community?.name || '—'}
                  {p.global && <span style={pill('rgba(11,107,203,0.14)', '#0b6bcb')}>🌍 global feed</span>}
                  <span style={pill(p.status === 'published' ? 'rgba(29,138,59,0.13)' : 'rgba(255,159,10,0.16)', p.status === 'published' ? '#1d8a3b' : '#b25000')}>{p.status}</span>
                </p>
                <p style={{ margin: 0, fontSize: 11.5, color: 'var(--muted)' }}>{fmt(p.publishedAt || p.createdAt)}</p>
              </div>
              {p.body && <p style={{ margin: '8px 0 0', fontSize: 14, whiteSpace: 'pre-wrap' }}>{p.body}</p>}
              {p.media.length > 0 && (
                <div style={{ display: 'flex', gap: 8, marginTop: 10, overflowX: 'auto' }}>
                  {p.media.map((m) => m.kind === 'video'
                    ? <video key={m.id} src={m.url} controls style={{ maxHeight: 160, borderRadius: 10 }} />
                    : <img key={m.id} src={m.url} alt="" style={{ maxHeight: 160, borderRadius: 10 }} />)}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                {p.status === 'draft' && <button style={mini} onClick={() => act(api.socialUpdatePost(scope, entityId, p.id, { status: 'published' }))}>Publish</button>}
                {p.status === 'published' && <button style={mini} onClick={() => act(api.socialUpdatePost(scope, entityId, p.id, { status: 'archived' }))}>Unpublish</button>}
                <button style={{ ...mini, color: '#c62828' }} onClick={() => window.confirm('Delete this post?') && act(api.socialDeletePost(scope, entityId, p.id))}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function CommunityForm({ communities, onCreate }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('organiser');
  const [eventId, setEventId] = useState('');
  const [visibility, setVisibility] = useState('public');
  const parent = communities.find((c) => c.type === 'organiser');
  return (
    <div style={card}>
      <label style={label}>Name</label>
      <input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Big Fest 2026" />
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <select style={{ ...input, width: 'auto', flex: 1, minWidth: 150 }} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="organiser">🏟 Organiser community</option>
          <option value="event">🎪 Event community</option>
        </select>
        <select style={{ ...input, width: 'auto', flex: 1, minWidth: 150 }} value={visibility} onChange={(e) => setVisibility(e.target.value)}>
          <option value="public">🌍 Public</option>
          <option value="members">🎟 Members only</option>
        </select>
      </div>
      {type === 'event' && (
        <div style={{ marginTop: 10 }}>
          <label style={label}>Howler event ID</label>
          <input style={input} value={eventId} onChange={(e) => setEventId(e.target.value.replace(/\D/g, ''))} placeholder="e.g. 19203" inputMode="numeric" />
          {parent && <p style={{ fontSize: 12, color: 'var(--muted)', margin: '5px 0 0' }}>Will nest under “{parent.name}”.</p>}
        </div>
      )}
      <button
        style={{ ...primary, marginTop: 12, opacity: !name.trim() || (type === 'event' && !eventId) ? 0.5 : 1 }}
        disabled={!name.trim() || (type === 'event' && !eventId)}
        onClick={() => onCreate({ name, type, visibility, ...(type === 'event' ? { eventId, parentId: parent?.id } : {}) })}
      >Create community</button>
    </div>
  );
}

function Composer({ communities, onCreate, scope, entityId }) {
  const [communityId, setCommunityId] = useState(communities[0]?.id || '');
  const [body, setBody] = useState('');
  const [global, setGlobal] = useState(false);
  const [media, setMedia] = useState([]); // [{id, kind, url, mime}]
  const [busy, setBusy] = useState(false);
  const [publishNow, setPublishNow] = useState(true);

  // Images are normalised IN THE BROWSER before upload: decoded (Safari also
  // decodes iPhone HEIC here), downscaled to ≤1920px and re-encoded as JPEG.
  // This is what makes phone photos render in the app — Flutter can't decode
  // HEIC — and keeps payloads far under the server's body limit. Videos go up
  // as-is (the dev disk path caps them; big video belongs to the R2 path).
  const MAX_EDGE = 1920;
  const normaliseImage = (file) => new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => { URL.revokeObjectURL(url); resolve(blob ? { blob, width: w, height: h } : null); }, 'image/jpeg', 0.85);
      } catch { URL.revokeObjectURL(url); resolve(null); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
  const toBase64 = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(blob);
  });

  const pickFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    e.target.value = '';
    setBusy(true);
    try {
      let payload;
      let dims = {};
      if (f.type.startsWith('image/')) {
        const norm = await normaliseImage(f);
        if (!norm) throw new Error('That image couldn’t be read in this browser — try a JPG/PNG export of it.');
        dims = { width: norm.width, height: norm.height };
        payload = { name: f.name.replace(/\.[a-z0-9]+$/i, '') + '.jpg', mime: 'image/jpeg', data: await toBase64(norm.blob) };
      } else {
        if (f.size > 3_500_000) throw new Error('Videos over ~3.5MB need the direct-to-storage upload (not configured yet) — use a short clip for now.');
        payload = { name: f.name, mime: f.type, data: await toBase64(f) };
      }
      const m = await api.socialUploadMedia(scope, entityId, payload);
      setMedia((list) => [...list, { ...m, ...dims }]);
    } catch (err) {
      alert(err.message || 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  const post = () => {
    setBusy(true);
    onCreate({ communityId, body, global, media, ...(publishNow ? { publish: true } : {}) })
      .finally(() => { setBody(''); setMedia([]); setBusy(false); });
  };

  return (
    <div style={card}>
      <select style={input} value={communityId} onChange={(e) => setCommunityId(e.target.value)}>
        {communities.filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{c.type === 'event' ? '🎪' : '🏟'} {c.name}</option>)}
      </select>
      <textarea style={{ ...input, marginTop: 10, minHeight: 90, resize: 'vertical' }} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What’s happening? Fans see this in the Howler app…" />
      {media.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, overflowX: 'auto' }}>
          {media.map((m, i) => (
            <div key={m.id} style={{ position: 'relative' }}>
              {m.kind === 'video' ? <video src={m.url} style={{ height: 90, borderRadius: 10 }} /> : <img src={m.url} alt="" style={{ height: 90, borderRadius: 10 }} />}
              <button style={{ ...tiny, position: 'absolute', top: 4, right: 4 }} onClick={() => setMedia((list) => list.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ ...mini, display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0 }}>
          📷 Add media
          <input type="file" accept="image/*,video/*" style={{ display: 'none' }} onChange={pickFile} />
        </label>
        <label style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} /> Also show on the Howler global feed
        </label>
        <label style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={publishNow} onChange={(e) => setPublishNow(e.target.checked)} /> Publish now
        </label>
        <button style={{ ...primary, marginLeft: 'auto', opacity: busy || (!body.trim() && !media.length) ? 0.5 : 1 }} disabled={busy || (!body.trim() && !media.length)} onClick={post}>
          {publishNow ? 'Post' : 'Save draft'}
        </button>
      </div>
    </div>
  );
}

const pill = (bg, fg) => ({ display: 'inline-block', marginLeft: 8, fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', background: bg, color: fg, borderRadius: 980, padding: '1px 8px', verticalAlign: 'middle' });
const label = { display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 };
const input = { width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 14, color: 'var(--text)', background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 10, padding: '9px 12px' };
const mini = { padding: '7px 12px', borderRadius: 8, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const tiny = { padding: '4px 8px', borderRadius: 7, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 12, cursor: 'pointer' };
const primary = { padding: '9px 18px', borderRadius: 980, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const card = { border: '1px solid var(--hairline)', borderRadius: 14, background: 'var(--card)', padding: '14px 16px', marginBottom: 12 };
