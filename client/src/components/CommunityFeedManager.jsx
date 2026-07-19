import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';
import ChatChannelsManager from './ChatChannelsManager.jsx';

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
              {/* Per-community comment settings — organiser opt-ins, off by default. */}
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!c.allowCommentImages} onChange={(e) => act(api.socialUpdateCommunity(scope, entityId, c.id, { allowCommentImages: e.target.checked }))} /> 📷 photos in comments
                </label>
                <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!c.allowCommentLinks} onChange={(e) => act(api.socialUpdateCommunity(scope, entityId, c.id, { allowCommentLinks: e.target.checked }))} /> 🔗 links in comments
                </label>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── House designation (platform admin only) ── */}
      {scope === 'admin' && <HouseToggle entityId={entityId} onError={(m) => setError(m)} />}

      {/* ── App posters: Howler accounts allowed to post from the app ── */}
      <AppPosters scope={scope} entityId={entityId} onError={(m) => setError(m)} />

      {/* ── Instagram import: one-click repost of existing IG content ── */}
      <InstagramImport scope={scope} entityId={entityId} communities={communities} onImported={load} onError={(m) => setError(m)} />

      {/* ── Moderation inbox: every fan comment across all posts ── */}
      {posts.length > 0 && <CommentsInbox scope={scope} entityId={entityId} onError={(m) => setError(m)} />}

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
                  {p.pinned && <span style={pill('rgba(245,179,1,0.16)', '#8a6d00')}>📌 pinned</span>}
                  {p.toParent && <span style={pill('rgba(29,138,59,0.13)', '#1d8a3b')} title="Also shows in the organiser community’s feed">⬆ organiser feed</span>}
                  {p.audience && <span style={pill('rgba(122,62,201,0.13)', '#7a3ec9')} title="Only matching ticket holders see this post in the app">{p.audience.type === 'holders' ? '🎟 ticket holders' : `🎯 ${(p.audience.ticketTypes || []).join(', ')}`}</span>}
                  <span style={pill(p.status === 'published' ? 'rgba(29,138,59,0.13)' : 'rgba(255,159,10,0.16)', p.status === 'published' ? '#1d8a3b' : '#b25000')}>{p.status}</span>
                </p>
                <p style={{ margin: 0, fontSize: 11.5, color: 'var(--muted)' }}>{p.reactionCount > 0 && <span style={{ marginRight: 8 }}>❤️ {p.reactionCount}</span>}{fmt(p.publishedAt || p.createdAt)}</p>
              </div>
              {p.body && <p style={{ margin: '8px 0 0', fontSize: 14, whiteSpace: 'pre-wrap' }}>{p.body}</p>}
              {p.ctaLabel && <p style={{ margin: '8px 0 0' }}><span style={{ display: 'inline-block', fontSize: 12.5, fontWeight: 700, background: 'var(--brand)', color: '#fff', borderRadius: 980, padding: '5px 14px' }}>{p.ctaLabel}</span> <span style={{ fontSize: 11, color: 'var(--muted)' }}>→ {p.ctaDestination}</span></p>}
              {p.media.length > 0 && (
                <div style={{ display: 'flex', gap: 8, marginTop: 10, overflowX: 'auto' }}>
                  {p.media.map((m) => m.kind === 'video'
                    ? <video key={m.id} src={m.url} controls style={{ maxHeight: 160, borderRadius: 10 }} />
                    : <img key={m.id} src={m.url} alt="" style={{ maxHeight: 160, borderRadius: 10 }} />)}
                </div>
              )}
              <PostComments scope={scope} entityId={entityId} post={p} onError={(m) => setError(m)} />
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                {p.status === 'draft' && <button style={mini} onClick={() => act(api.socialUpdatePost(scope, entityId, p.id, { status: 'published' }))}>🚀 Publish</button>}
                {p.status === 'published' && <button style={mini} onClick={() => act(api.socialUpdatePost(scope, entityId, p.id, { status: 'archived' }))}>⏸ Unpublish</button>}
                {p.status === 'published' && <button style={mini} title={p.pinned ? 'Unpin from the top of the feed' : 'Pin to the top of the feed'} onClick={() => act(api.socialPinPost(scope, entityId, p.id, !p.pinned))}>{p.pinned ? '📌 Unpin' : '📌 Pin'}</button>}
                <button
                  style={{ ...mini, color: '#c62828', borderColor: 'rgba(198,40,40,0.4)', marginLeft: 'auto' }}
                  onClick={() => window.confirm('Delete this post for good? It disappears from the app feed immediately.') && act(api.socialDeletePost(scope, entityId, p.id))}
                >🗑 Delete</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Event chat channels (phase 2) — event ids suggested from event communities ── */}
      <ChatChannelsManager entityId={entityId} scope={scope} eventIds={[...new Set(communities.filter((c) => c.eventId).map((c) => c.eventId))]} />
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
  // Optional CTA button on the post — rendered by the app with its existing
  // CTA system (destinations are the app's screen keywords; event id rides
  // along automatically for event communities).
  const [showCta, setShowCta] = useState(false);
  const [ctaLabel, setCtaLabel] = useState('');
  const [ctaScreen, setCtaScreen] = useState('explore_tickets');
  const [ctaUrl, setCtaUrl] = useState('');
  const [ctaEventId, setCtaEventId] = useState('');
  const CTA_SCREENS = [
    ['explore_tickets', '🎟 Tickets'], ['explore', '📄 Event page'], ['explore_lineup', '🎤 Line-up'],
    ['explore_map', '🗺 Map'], ['explore_merch', '🛍 Merch'], ['explore_feed', '📰 Event feed'],
    ['open_url', '🔗 Custom link'],
  ];
  // Direct-to-cloud uploads (Cloudflare R2 via presigned PUT) when the server
  // has SOCIAL_S3_* configured — media bytes skip Pulse entirely. Falls back
  // to the base64→Pulse-disk path when unconfigured or blocked (e.g. CORS).
  const [direct, setDirect] = useState(false);
  useEffect(() => {
    api.socialMediaConfig(scope, entityId).then((c) => setDirect(!!c.direct)).catch(() => setDirect(false));
  }, [scope, entityId]);

  const directUpload = async (blobOrFile, name, mime, dims) => {
    const pre = await api.socialPresignMedia(scope, entityId, { name, mime });
    const put = await fetch(pre.uploadUrl, { method: 'PUT', headers: pre.headers, body: blobOrFile });
    if (!put.ok) throw new Error(`Cloud upload failed (${put.status})`);
    return { kind: pre.kind, url: pre.publicUrl, mime, ...dims };
  };

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

  const MAX_MEDIA = 10; // matches the server's MAX_MEDIA_PER_POST

  // Upload one file → a served media item (Instagram-style multi-photo posts
  // share this per-file path; the composer loops over the whole selection).
  const uploadOne = async (f) => {
    // Images: always normalised (HEIC→JPEG, ≤1920px) whichever path uploads.
    let blob = f, name = f.name, mime = f.type, dims = {};
    if (f.type.startsWith('image/')) {
      const norm = await normaliseImage(f);
      if (!norm) throw new Error(`“${f.name}” couldn’t be read in this browser — try a JPG/PNG export of it.`);
      blob = norm.blob;
      dims = { width: norm.width, height: norm.height };
      name = f.name.replace(/\.[a-z0-9]+$/i, '') + '.jpg';
      mime = 'image/jpeg';
    }
    let item = null;
    let directErr = null;
    if (direct) {
      try { item = await directUpload(blob, name, mime, dims); }
      catch (err) { directErr = err; console.warn('[social] direct upload failed, falling back to Pulse upload:', err.message); }
    }
    if (!item) {
      if (!mime.startsWith('image/') && blob.size > 3_500_000) {
        // Surface the REAL reason — a "Load failed"/"Failed to fetch" here
        // is the browser blocking the cross-origin PUT (bucket CORS policy
        // missing/wrong); a status code is the bucket rejecting it.
        const why = directErr ? ` Cloud upload said: ${directErr.message} — a network/fetch error here usually means the bucket's CORS policy is missing.` : '';
        throw new Error(direct
          ? `The cloud upload failed and this video is too big for the fallback.${why}`
          : 'Videos over ~3.5MB need direct-to-cloud uploads (Cloudflare R2, not configured yet) — use a short clip for now.');
      }
      item = { ...(await api.socialUploadMedia(scope, entityId, { name, mime, data: await toBase64(blob) })), ...dims };
    }
    return item;
  };

  // Pick one OR MANY at once — the order you select is the carousel order in
  // the app (drag not needed; reorder with the ◀ ▶ buttons on each thumb).
  const pickFile = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    const room = MAX_MEDIA - media.length;
    if (room <= 0) { alert(`A post can hold up to ${MAX_MEDIA} photos/videos.`); return; }
    const toAdd = files.slice(0, room);
    if (files.length > room) alert(`Only the first ${room} added — a post holds up to ${MAX_MEDIA}.`);
    setBusy(true);
    try {
      for (const f of toAdd) {
        const item = await uploadOne(f); // sequential keeps upload order = pick order
        setMedia((list) => [...list, item]);
      }
    } catch (err) {
      alert(err.message || 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  const moveMedia = (i, dir) => setMedia((list) => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const selectedCommunity = communities.find((c) => c.id === communityId);
  const ctaNeedsEventId = ctaScreen !== 'open_url' && !selectedCommunity?.eventId;
  // Targeting (event communities only): everyone / any ticket holder /
  // specific ticket type names. Targeted posts never ride the global feed.
  const [audienceType, setAudienceType] = useState('everyone');
  const [ticketTypes, setTicketTypes] = useState('');
  const targeted = selectedCommunity?.eventId && audienceType !== 'everyone';
  const [toParent, setToParent] = useState(false); // event → organiser roll-up
  const buildAudience = () => {
    if (!selectedCommunity?.eventId || audienceType === 'everyone') return {};
    if (audienceType === 'holders') return { audience: { type: 'holders' } };
    return { audience: { type: 'ticketTypes', ticketTypes: ticketTypes.split(',').map((s) => s.trim()).filter(Boolean) } };
  };
  const buildCta = () => {
    if (!showCta || !ctaLabel.trim()) return {};
    const destination = ctaScreen === 'open_url'
      ? `open_url:${ctaUrl.trim()}`
      : `${ctaScreen}${(selectedCommunity?.eventId || ctaEventId) ? `:${selectedCommunity?.eventId || ctaEventId}` : ''}`;
    return { ctaLabel: ctaLabel.trim(), ctaDestination: destination };
  };

  const post = () => {
    setBusy(true);
    if (audienceType === 'ticketTypes' && !ticketTypes.split(',').some((s) => s.trim())) {
      alert('List at least one ticket type name to target (comma separated, exactly as they appear on tickets)');
      setBusy(false);
      return;
    }
    onCreate({ communityId, body, global: targeted ? false : global, toParent: selectedCommunity?.parentId ? toParent : false, media, ...buildCta(), ...buildAudience(), ...(publishNow ? { publish: true } : {}) })
      .finally(() => { setBody(''); setMedia([]); setCtaLabel(''); setCtaUrl(''); setShowCta(false); setAudienceType('everyone'); setTicketTypes(''); setToParent(false); setBusy(false); });
  };

  return (
    <div style={card}>
      <select style={input} value={communityId} onChange={(e) => setCommunityId(e.target.value)}>
        {communities.filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{c.type === 'event' ? '🎪' : '🏟'} {c.name}</option>)}
      </select>
      <textarea style={{ ...input, marginTop: 10, minHeight: 90, resize: 'vertical' }} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What’s happening? Fans see this in the Howler app…" />
      {media.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, overflowX: 'auto' }}>
            {media.map((m, i) => (
              <div key={m.id} style={{ position: 'relative', flex: '0 0 auto' }}>
                {m.kind === 'video' ? <video src={m.url} style={{ height: 90, borderRadius: 10, display: 'block' }} /> : <img src={m.url} alt="" style={{ height: 90, borderRadius: 10, display: 'block' }} />}
                {/* Order badge — the app shows these as a swipeable carousel in this order. */}
                {media.length > 1 && <span style={{ position: 'absolute', top: 4, left: 4, fontSize: 10, fontWeight: 700, color: '#fff', background: 'rgba(0,0,0,0.6)', borderRadius: 980, padding: '1px 6px' }}>{i + 1}/{media.length}</span>}
                <button style={{ ...tiny, position: 'absolute', top: 4, right: 4 }} title="Remove" onClick={() => setMedia((list) => list.filter((_, j) => j !== i))}>✕</button>
                {media.length > 1 && (
                  <div style={{ position: 'absolute', bottom: 4, left: 4, right: 4, display: 'flex', justifyContent: 'space-between' }}>
                    <button style={{ ...tiny, opacity: i === 0 ? 0.3 : 1 }} disabled={i === 0} title="Move earlier" onClick={() => moveMedia(i, -1)}>◀</button>
                    <button style={{ ...tiny, opacity: i === media.length - 1 ? 0.3 : 1 }} disabled={i === media.length - 1} title="Move later" onClick={() => moveMedia(i, 1)}>▶</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {media.length > 1 && <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--muted)' }}>Fans swipe through these in order — reorder with ◀ ▶.</p>}
        </>
      )}
      {showCta && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center', border: '1px dashed var(--hairline)', borderRadius: 10, padding: '10px 12px' }}>
          <input style={{ ...input, width: 'auto', flex: 1, minWidth: 140 }} value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)} placeholder="Button label, e.g. Get tickets" maxLength={40} />
          <select style={{ ...input, width: 'auto', minWidth: 140 }} value={ctaScreen} onChange={(e) => setCtaScreen(e.target.value)}>
            {CTA_SCREENS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {ctaScreen === 'open_url' && (
            <input style={{ ...input, width: 'auto', flex: 2, minWidth: 180 }} value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} placeholder="https://…" />
          )}
          {ctaNeedsEventId && (
            <input style={{ ...input, width: 'auto', minWidth: 130 }} value={ctaEventId} onChange={(e) => setCtaEventId(e.target.value.replace(/\D/g, ''))} placeholder="Event ID" inputMode="numeric" title="Organiser-community posts need the target event's ID; event-community posts fill this automatically" />
          )}
        </div>
      )}
      {selectedCommunity?.eventId && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>🎯 Who sees it:</span>
          <select style={{ ...input, width: 'auto', minWidth: 170 }} value={audienceType} onChange={(e) => setAudienceType(e.target.value)}>
            <option value="everyone">🌍 Everyone</option>
            <option value="holders">🎟 Any ticket holder</option>
            <option value="ticketTypes">🎯 Specific ticket types</option>
          </select>
          {audienceType === 'ticketTypes' && (
            <input
              style={{ ...input, width: 'auto', flex: 1, minWidth: 220 }}
              value={ticketTypes}
              onChange={(e) => setTicketTypes(e.target.value)}
              placeholder="Ticket type names, comma separated — e.g. VIP, Weekend Pass"
              title="Exact ticket type names as fans hold them (case doesn’t matter)"
            />
          )}
          {targeted && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>targeted posts stay off the Howler-wide feed</span>}
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ ...mini, display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0 }} title={direct ? 'Uploads go direct to cloud storage (R2)' : 'Uploads go via Pulse (images auto-optimised; videos capped until R2 is configured)'}>
          {direct ? '📷☁️ Add media' : '📷 Add media'}
          <input type="file" accept="image/*,video/*" multiple style={{ display: 'none' }} onChange={pickFile} />
        </label>
        <button style={{ ...mini, background: showCta ? 'rgba(11,107,203,0.10)' : 'var(--card)' }} onClick={() => setShowCta((v) => !v)}>🔘 Button</button>
        <label style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: targeted ? 'not-allowed' : 'pointer', opacity: targeted ? 0.45 : 1 }} title={targeted ? 'Targeted posts stay off the Howler-wide feed' : ''}>
          <input type="checkbox" disabled={!!targeted} checked={targeted ? false : global} onChange={(e) => setGlobal(e.target.checked)} /> Also show on the Howler global feed
        </label>
        {selectedCommunity?.parentId && (
          <label style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }} title="Rolls this event post up into the organiser community’s feed too">
            <input type="checkbox" checked={toParent} onChange={(e) => setToParent(e.target.checked)} /> ⬆ Also on the organiser feed
          </label>
        )}
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

// One comment row — shared by the per-post list and the moderation inbox.
// Organiser replies get a brand badge; reported comments are flagged loudly.
// Platform-level: which client is "Howler's own voice". The house entity's
// global posts reach EVERYONE in the app (incl. before login); every other
// client's global posts only reach their followers + ticket holders.
function HouseToggle({ entityId, onError }) {
  const [house, setHouse] = useState(null);
  useEffect(() => { api.socialGetHouse().then((d) => setHouse(d.entityId || '')).catch(() => setHouse('')); }, []);
  if (house === null) return null;
  const isHouse = house === entityId;
  return (
    <section style={{ marginTop: 18 }}>
      <label style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer' }} title="House posts on the Howler global feed reach every app user; other organisers only reach their followers and ticket holders">
        <input
          type="checkbox"
          checked={isHouse}
          onChange={(e) => api.socialSetHouse(e.target.checked ? entityId : '').then((d) => setHouse(d.entityId || '')).catch((err) => onError(err.message || 'Could not update'))}
        /> 🏠 This client is <b>Howler’s own voice</b> — its global-feed posts reach everyone
      </label>
      {house && !isHouse && <p style={{ margin: '4px 0 0', fontSize: 11.5, color: 'var(--muted)' }}>Another client currently holds the house role.</p>}
    </section>
  );
}

// Howler app accounts authorised to publish for this client straight from the
// app (they see a composer in the app; posts go live in the brand's voice, or
// under the display name set here). Find user ids in staging Active Admin.
function AppPosters({ scope, entityId, onError }) {
  const [posters, setPosters] = useState(null);
  const [uid, setUid] = useState('');
  const [name, setName] = useState('');
  useEffect(() => { api.socialPosters(scope, entityId).then((d) => setPosters(d.posters || [])).catch(() => setPosters([])); }, [scope, entityId]);
  const run = (p) => p.then((d) => setPosters(d.posters || [])).catch((e) => onError(e.message || 'That didn’t save'));
  return (
    <section style={{ marginTop: 18 }}>
      <h3 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 750 }}>📲 App posters</h3>
      <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--muted)' }}>
        These Howler app accounts can publish posts for you straight from the app — no Pulse login needed.
        Leave the display name blank to post in the brand’s voice.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <input value={uid} onChange={(e) => setUid(e.target.value)} placeholder="Howler user id (e.g. 661779)" style={{ width: 210 }} />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name (optional)" style={{ width: 190 }} />
        <button
          disabled={!/^\d+$/.test(uid.trim())}
          onClick={() => { run(api.socialAddPoster(scope, entityId, { howlerUserId: uid.trim(), name: name.trim() })); setUid(''); setName(''); }}
        >＋ Allow</button>
      </div>
      {posters === null ? <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>Loading…</p> : posters.length === 0
        ? <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: 0 }}>Nobody yet — posting stays Pulse-only until you allow someone.</p>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {posters.map((p) => (
              <div key={p.howlerUserId} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <span style={{ fontWeight: 600 }}>{p.name || 'Brand voice'}</span>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>Howler user {p.howlerUserId}</span>
                <button style={{ marginLeft: 'auto' }} title="Remove — they can no longer post from the app" onClick={() => run(api.socialRemovePoster(scope, entityId, p.howlerUserId))}>✕</button>
              </div>
            ))}
          </div>
        )}
    </section>
  );
}

// One-click repost of content already on the client's Instagram: grid of
// recent IG media → Import re-hosts the media through Pulse (IG CDN links
// expire) and publishes with the caption prefilled. Needs the Meta token +
// IG account id from Integrations (same connection social metrics uses).
function InstagramImport({ scope, entityId, communities, onImported, onError }) {
  const [state, setState] = useState(null); // null=loading, {connected, media}
  const [communityId, setCommunityId] = useState('');
  const [global, setGlobal] = useState(true);
  const [busy, setBusy] = useState('');
  useEffect(() => {
    setState(null);
    api.socialInstagramMedia(scope, entityId).then(setState).catch(() => setState({ connected: false, media: [] }));
  }, [scope, entityId]);
  const target = communityId || communities[0]?.id || '';
  const doImport = (m) => {
    if (!target) { onError('Create a community first'); return; }
    setBusy(m.id);
    api.socialInstagramImport(scope, entityId, { mediaId: m.id, communityId: target, global })
      .then(() => { setBusy(''); onImported(); })
      .catch((e) => { setBusy(''); onError(e.message || 'Import failed'); });
  };
  return (
    <section style={{ marginTop: 18 }}>
      <h3 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 750 }}>📸 Instagram</h3>
      {state === null ? <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>Loading your Instagram…</p>
        : !state.connected ? (
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>
            Not connected — add your Meta access token and Instagram account id under Integrations
            (the same connection social metrics uses), then your recent posts appear here for one-click reposting.
          </p>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
              <select value={target} onChange={(e) => setCommunityId(e.target.value)}>
                {communities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <label style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <input type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} /> 🌍 also on the Howler feed
              </label>
            </div>
            {state.media.length === 0
              ? <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: 0 }}>No recent posts found on the connected Instagram account.</p>
              : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
                  {state.media.map((m) => (
                    <div key={m.id} style={{ border: '1px solid var(--line, #e3e0d8)', borderRadius: 10, overflow: 'hidden' }}>
                      {m.thumbnailUrl
                        ? <img src={m.thumbnailUrl} alt="" style={{ width: '100%', aspectRatio: '1/1', objectFit: 'cover', display: 'block' }} />
                        : <div style={{ width: '100%', aspectRatio: '1/1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26 }}>{m.type === 'VIDEO' ? '🎬' : '🖼'}</div>}
                      <div style={{ padding: '6px 8px' }}>
                        <p style={{ margin: 0, fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {m.type === 'CAROUSEL_ALBUM' ? `🖼×${m.childCount} ` : m.type === 'VIDEO' ? '🎬 ' : ''}{m.caption || '(no caption)'}
                        </p>
                        <button
                          style={{ marginTop: 6, width: '100%', fontSize: 12 }}
                          disabled={busy === m.id}
                          onClick={() => doImport(m)}
                        >{busy === m.id ? 'Importing…' : '⤵ Post on Howler'}</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
          </>
        )}
    </section>
  );
}

function CommentItem({ scope, entityId, comment, onChanged, onError, postContext }) {
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState('');
  const c = comment;
  const sendReply = () => api.socialReplyComment(scope, entityId, c.id, replyText)
    .then(() => { setReplying(false); setReplyText(''); onChanged(); })
    .catch((e) => onError(e.message || 'Reply failed'));
  return (
    <div style={{ background: c.reported ? 'rgba(198,40,40,0.07)' : 'rgba(128,128,128,0.06)', borderRadius: 10, padding: '7px 10px', marginLeft: c.parentCommentId ? 22 : 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 12.5 }}>
            <strong>{c.author.name}</strong>
            {c.authorType === 'organiser' && <span style={pill('rgba(11,107,203,0.14)', '#0b6bcb')}>🏟 organiser</span>}
            {c.reported && <span style={pill('rgba(198,40,40,0.14)', '#c62828')}>⚠ reported</span>}
            {postContext && <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 8 }}>on “{postContext.body || postContext.communityName}…”</span>}
          </p>
          {c.text && <p style={{ margin: '2px 0 0', fontSize: 13, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{c.text}</p>}
          {(c.media || []).map((m) => <img key={m.id} src={m.url} alt="" style={{ maxHeight: 90, borderRadius: 8, marginTop: 6 }} />)}
        </div>
        {!c.parentCommentId && c.authorType !== 'organiser' && (
          <button style={tiny} title="Reply as the organiser" onClick={() => setReplying((v) => !v)}>↩</button>
        )}
        <button style={{ ...tiny, color: '#c62828' }} title="Delete comment"
          onClick={() => window.confirm('Delete this comment?') && api.socialDeleteComment(scope, entityId, c.id).then(onChanged).catch((e) => onError(e.message || 'Delete failed'))}>🗑</button>
      </div>
      {replying && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <input style={{ ...input, fontSize: 12.5, padding: '6px 10px' }} value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="Reply as your brand…" onKeyDown={(e) => e.key === 'Enter' && replyText.trim() && sendReply()} />
          <button style={{ ...mini, opacity: replyText.trim() ? 1 : 0.5 }} disabled={!replyText.trim()} onClick={sendReply}>Send</button>
        </div>
      )}
    </div>
  );
}

// Fan comments on a post — count, expandable list, replies + moderation.
function PostComments({ scope, entityId, post, onError }) {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState(null);
  const flat = comments ? comments.flatMap((c) => [c, ...(c.replies || [])]) : null;
  const count = flat ? flat.length : post.commentCount || 0;
  const load = () => api.socialComments(scope, entityId, post.id).then((r) => setComments(r.comments || [])).catch(() => setComments([]));
  const toggle = () => { setOpen((v) => !v); if (!open && comments === null) load(); };
  if (!count && !open) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <button style={{ border: 'none', background: 'none', padding: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--muted)', cursor: 'pointer' }} onClick={toggle}>
        💬 {count} comment{count === 1 ? '' : 's'} {open ? '▴' : '▾'}
      </button>
      {open && flat && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {flat.map((c) => <CommentItem key={c.id} scope={scope} entityId={entityId} comment={c} onChanged={load} onError={onError} />)}
          {flat.length === 0 && <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>No comments.</p>}
        </div>
      )}
    </div>
  );
}

// The organiser's moderation inbox — every comment across all posts, reported
// first, each with post context, reply and delete.
function CommentsInbox({ scope, entityId, onError }) {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState(null);
  const load = () => api.socialAllComments(scope, entityId).then((r) => setComments(r.comments || [])).catch(() => setComments([]));
  const toggle = () => { setOpen((v) => !v); if (!open && comments === null) load(); };
  const reported = comments ? comments.filter((c) => c.reported).length : 0;
  return (
    <section>
      <button style={{ border: 'none', background: 'none', padding: 0, fontSize: 15, fontWeight: 750, color: 'var(--text)', cursor: 'pointer' }} onClick={toggle}>
        💬 Comments inbox {comments ? `(${comments.length}${reported ? ` · ⚠ ${reported} reported` : ''})` : ''} {open ? '▴' : '▾'}
      </button>
      {open && comments && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
          {comments.length === 0 && <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>No fan comments yet.</p>}
          {comments.map((c) => <CommentItem key={c.id} scope={scope} entityId={entityId} comment={c} onChanged={load} onError={onError} postContext={c.post} />)}
        </div>
      )}
    </section>
  );
}

const pill = (bg, fg) => ({ display: 'inline-block', marginLeft: 8, fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', background: bg, color: fg, borderRadius: 980, padding: '1px 8px', verticalAlign: 'middle' });
const label = { display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 };
const input = { width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 14, color: 'var(--text)', background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 10, padding: '9px 12px' };
const mini = { padding: '7px 12px', borderRadius: 8, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const tiny = { padding: '4px 8px', borderRadius: 7, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 12, cursor: 'pointer' };
const primary = { padding: '9px 18px', borderRadius: 980, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const card = { border: '1px solid var(--hairline)', borderRadius: 14, background: 'var(--card)', padding: '14px 16px', marginBottom: 12 };
