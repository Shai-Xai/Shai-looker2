import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import PlatformIcon from './PlatformIcon.jsx';
import { AudienceFilters } from './CampaignManager.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { viaBadge, viaChipStyle } from '../lib/createdVia.js';

// Built-in recipes we can materialise into a real segment right now by
// auto-resolving the source from the client's data (key = actionTemplates key).
const RECIPE_SEGMENTS = [
  { key: 'abandoned_cart', name: 'Abandoned carts', icon: '🛒', desc: 'Customers who started a ticket purchase but didn’t finish — auto-built from your data.' },
];

// Visual placeholders shown under the live segments — common audiences we'll
// auto-build from the client's data. Not yet wired up ("coming soon").
const SUGGESTED_SEGMENTS = [
  { name: 'New customers', icon: '✨', desc: 'First-time buyers — never purchased before this event.' },
  { name: 'Returning customers', icon: '🔁', desc: 'Bought at a previous event too — your repeat base.' },
  { name: 'Most loyal', icon: '💛', desc: 'Attended the most events over time.' },
  { name: 'Top spenders', icon: '💎', desc: 'Highest lifetime spend across all events.' },
  { name: 'Lapsed buyers', icon: '😴', desc: "Bought before but haven't in a while — ripe for win-back." },
  { name: 'VIP ticket holders', icon: '🎟️', desc: 'Bought VIP / premium tiers.' },
];

// Segments — reusable LIVE audiences. List + a builder that re-uses the campaign
// audience picker (tile + columns + filters) and the audience-preview endpoint
// for the live count. Same component serves admin + client self-service.
export default function SegmentManager({ entityId, scope = 'admin' }) {
  const isAdmin = scope === 'admin';
  const isMobile = useIsMobile();
  const [segments, setSegments] = useState(null);
  const [tiles, setTiles] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | segment object
  const [busyId, setBusyId] = useState(null);
  const [viewing, setViewing] = useState(null); // { segment, data | null } — people modal
  const [addingKey, setAddingKey] = useState('');
  const [syncMsg, setSyncMsg] = useState({}); // segmentId -> last Meta-sync status line
  const [metaConnected, setMetaConnected] = useState(false);
  const [tiktokConnected, setTiktokConnected] = useState(false);
  const [connectors, setConnectors] = useState({});
  const [filterEvent, setFilterEvent] = useState('');   // filter the list by linked event (folders are group headers)

  const load = () => api.listSegments(entityId).then((r) => { setSegments(r.segments || []); setMetaConnected(!!r.metaConnected); setTiktokConnected(!!r.tiktokConnected); setConnectors(r.connectors || {}); }).catch(() => setSegments([]));
  // Materialise a built-in recipe (e.g. abandoned cart) as a real, live segment.
  const addRecipe = async (r) => {
    setAddingKey(r.key);
    try { await api.createSegmentFromRecipe(entityId, r.key); await load(); }
    catch {
      // Couldn't auto-find the source tile in this client's data — don't dead-end;
      // open the editor prefilled so they can pick the tile themselves.
      setEditing({ name: r.name, definition: { mode: 'tile' } });
    }
    finally { setAddingKey(''); }
  };
  useEffect(() => { load(); }, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { (isAdmin ? api.getDigestTiles(entityId) : api.getMyDigestTiles(entityId)).then(setTiles).catch(() => setTiles({ dashboards: [] })); }, [entityId, isAdmin]);

  // Auto-count: when the list loads, resolve any segment that's never been counted
  // (count === -1) in the background so its size shows without a manual refresh —
  // e.g. a just-added abandoned-cart recipe. Each id is attempted once per visit
  // (errored/empty ones won't loop); capped per cycle to avoid a thundering herd.
  const warmedRef = useRef(new Set());
  useEffect(() => {
    if (!segments || !segments.length) return;
    const todo = segments.filter((s) => s.count < 0 && !warmedRef.current.has(s.id)).slice(0, 8);
    if (!todo.length) return;
    todo.forEach((s) => warmedRef.current.add(s.id));
    (async () => { await Promise.all(todo.map((s) => api.previewSegment(entityId, s.id).catch(() => {}))); load(); })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments]);

  // Resolve the source labels (event / dashboard / tile) from the tiles catalog.
  const sourceLabel = (s) => {
    const d = s.definition || {};
    if (d.sources && d.sources.length) return { event: '', detail: `Combined · ${d.combine || 'union'} of ${d.sources.length} sources` };
    if (d.mode === 'paste') return { event: '', detail: 'Uploaded / pasted list' };
    if (d.mode === 'gsheet') return { event: '', detail: 'Linked Google Sheet (live)' };
    if (d.mode === 'appmatch') return { event: '', detail: 'App audience group (live — recomputed at every send)' };
    const dash = tiles?.dashboards?.find((x) => x.dashboardId === d.dashboardId);
    const tile = dash?.tiles?.find((t) => t.tileId === d.tileId);
    return { event: dash?.suiteName || '', detail: tile?.title || dash?.title || '' };
  };

  if (!segments) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>;

  if (editing) {
    return <SegmentBuilder entityId={entityId} tiles={tiles} segment={editing === 'new' ? null : editing}
      onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />;
  }

  // A failed count must SAY so — swallowing the error made a broken segment's
  // Refresh look like the button did nothing.
  const refresh = (s) => {
    setBusyId(s.id);
    setSyncMsg((m) => ({ ...m, [s.id]: '' }));
    api.previewSegment(entityId, s.id).then(load)
      .catch((e) => setSyncMsg((m) => ({ ...m, [s.id]: `✗ Couldn’t count this segment — ${e.message || 'something went wrong'}. Open Edit to check its source tile/filters.` })))
      .finally(() => setBusyId(null));
  };
  const del = (s) => { if (confirm(`Delete segment “${s.name}”?`)) api.deleteSegment(entityId, s.id).then(load); };
  const viewPeople = (s) => { setViewing({ segment: s, data: null }); api.segmentMembers(entityId, s.id).then((d) => setViewing({ segment: s, data: d })).catch((e) => setViewing({ segment: s, data: { error: e.message } })); };
  const syncMeta = async (s) => {
    setSyncMsg((m) => ({ ...m, [s.id]: '…mirroring to Meta' })); setBusyId(s.id);
    try { const r = await api.syncSegmentMeta(entityId, s.id); setSyncMsg((m) => ({ ...m, [s.id]: `✓ Sent ${r.received ?? r.pushed} to Meta — matching runs on Meta’s side` })); await load(); }
    catch (e) { setSyncMsg((m) => ({ ...m, [s.id]: `✗ ${e.message}` })); }
    finally { setBusyId(null); }
  };
  const syncTikTok = async (s) => {
    setSyncMsg((m) => ({ ...m, [s.id]: '…mirroring to TikTok' })); setBusyId(s.id);
    try {
      const r = await api.syncSegmentTikTok(entityId, s.id);
      const delta = (r.added || r.removed) ? ` (+${r.added || 0} −${r.removed || 0})` : '';
      setSyncMsg((m) => ({ ...m, [s.id]: `✓ ${r.received ?? r.pushed} mirrored to TikTok${delta} — matching runs on TikTok’s side` })); await load();
    } catch (e) { setSyncMsg((m) => ({ ...m, [s.id]: `✗ ${e.message}` })); }
    finally { setBusyId(null); }
  };
  const fmtWhen = (iso) => { try { return new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
  // One connector's line under a segment: sync status (or "not synced yet") + a link out.
  const connLine = (icon, label, sync, url) => (
    <div style={{ fontSize: 11.5, display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', color: sync?.status === 'error' ? 'var(--error,#ef4444)' : 'var(--muted)' }}>
      <span>{icon} {label}:</span>
      <span>{sync ? (sync.status === 'error' ? `last sync failed — ${sync.error}` : `${sync.received} mirrored · ${fmtWhen(sync.at)}${sync.audienceId ? ` · audience ${sync.audienceId}` : ''}`) : 'connected · not synced yet'}</span>
      {url && <a href={url} target="_blank" rel="noreferrer" style={{ color: 'var(--brand)', fontWeight: 600 }}>open ↗</a>}
    </div>
  );

  // Organise: the client's events (from the tiles catalog) for the per-segment event
  // link, and the distinct folders in use. Both feed the inline pickers + the filters.
  const eventOpts = (() => { const m = new Map(); for (const d of (tiles?.dashboards || [])) if (d.suiteId && !m.has(d.suiteId)) m.set(d.suiteId, d.suiteName || d.title || 'Event'); return [...m].map(([id, name]) => ({ id, name })); })();
  const eventName = (id) => (eventOpts.find((e) => e.id === id) || {}).name || '';
  const folderOpts = [...new Set(segments.map((s) => s.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const setSegFolder = (s, folder) => api.updateSegment(entityId, s.id, { folder }).then(load).catch(() => {});
  const setSegEvent = (s, suiteId) => api.updateSegment(entityId, s.id, { suiteId }).then(load).catch(() => {});
  const shown = segments.filter((s) => !filterEvent || s.suiteId === filterEvent);
  const orgSel = { padding: '4px 7px', borderRadius: 8, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 12 };

  // Landing page is grouped by FOLDER: named folders A→Z, then everything
  // un-filed in one "Unfiled" group at the bottom. Only group when folders are
  // actually in use — otherwise a single "Unfiled" header is just noise.
  const grouped = folderOpts.length > 0;
  const folderGroups = (() => {
    const m = new Map();
    for (const s of shown) { const k = s.folder || ''; if (!m.has(k)) m.set(k, []); m.get(k).push(s); }
    const named = [...m.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b));
    const order = m.has('') ? [...named, ''] : named; // unfiled last
    return order.map((k) => ({ folder: k, items: m.get(k) }));
  })();
  const groupHead = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700, color: 'var(--text)', padding: '2px 2px 0' };

  // One segment card (shared by the flat list and the per-folder groups).
  const renderCard = (s) => {
    const lbl = sourceLabel(s);
    return (
      <div key={s.id} style={{ border: '1px solid var(--hairline)', borderRadius: 14, padding: isMobile ? '16px' : '14px 16px', display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'stretch' : 'center', flexWrap: isMobile ? 'nowrap' : 'wrap', gap: isMobile ? 12 : 14, background: 'var(--card)' }}>
        <div style={{ flex: isMobile ? undefined : '1 1 240px', minWidth: isMobile ? 0 : 220 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: isMobile ? 17 : 15 }}>{s.name}</span>
            <span style={{ fontSize: 10.5, fontWeight: 700, borderRadius: 980, padding: '2px 9px', background: 'rgba(128,128,128,0.14)', color: 'var(--muted)' }}>{s.source === 'mix' ? 'Combined' : s.source === 'paste' ? 'Uploaded / pasted' : s.source === 'gsheet' ? 'Google Sheet' : s.source === 'appmatch' ? '📲 App audience (live)' : 'Dashboard tile'}</span>
            {viaBadge(s.createdVia) && <span style={viaChipStyle}>{viaBadge(s.createdVia).icon} via {viaBadge(s.createdVia).label}</span>}
          </div>
          {lbl.event && <div style={{ fontSize: 12.5, color: 'var(--text)', marginTop: 5, fontWeight: 600 }}>🗓 {lbl.event}</div>}
          {lbl.detail && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lbl.detail}</div>}
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>
            {busyId === s.id
              ? <div style={{ maxWidth: 240 }}><div style={{ marginBottom: 4 }}>⏳ Counting the audience…</div><div className="indet-track" /></div>
              : s.count >= 0
                ? <span><b style={{ color: 'var(--brand)' }}>{s.count}</b> {s.count === 1 ? 'person' : 'people'}{s.lastResolvedAt ? ` · as of ${new Date(s.lastResolvedAt).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</span>
                : <span>Not counted yet — tap refresh</span>}
          </div>
          {s.count >= 0 && s.reach && (s.reach.email >= 0 || s.reach.sms >= 0) && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {s.reach.email >= 0 && <span>✉️ {s.reach.email} with email</span>}
              {s.reach.sms >= 0 && <span>💬 {s.reach.sms} with mobile</span>}
            </div>
          )}
          {/* Organise: link this segment to an event and/or file it in a folder.
              Both patch immediately; folder is free-text (existing folders
              suggested via datalist) so you can group however you like. */}
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {eventOpts.length > 0 && (
              <select value={s.suiteId || ''} onChange={(e) => setSegEvent(s, e.target.value)} style={orgSel} aria-label="Link to event" title="Link this segment to an event">
                <option value="">🗓 No event</option>
                {eventOpts.map((ev) => <option key={ev.id} value={ev.id}>🗓 {ev.name}</option>)}
              </select>
            )}
            <input list={`seg-folders-${s.id}`} value={s.folder || ''} placeholder="📁 Folder…"
              onChange={(e) => setSegments((arr) => arr.map((x) => (x.id === s.id ? { ...x, folder: e.target.value } : x)))}
              onBlur={(e) => { const v = e.target.value.trim(); if (v !== (s.folder || '')) setSegFolder(s, v); }}
              style={{ ...orgSel, width: 130 }} aria-label="Folder" title="File this segment in a folder" />
            <datalist id={`seg-folders-${s.id}`}>{folderOpts.map((f) => <option key={f} value={f} />)}</datalist>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
          <button style={{ ...mini, flex: isMobile ? 1 : undefined, padding: isMobile ? '10px 12px' : mini.padding }} onClick={() => viewPeople(s)}>👥 List</button>
          <button style={{ ...mini, flex: isMobile ? 1 : undefined, padding: isMobile ? '10px 12px' : mini.padding }} onClick={() => refresh(s)} disabled={busyId === s.id}>{busyId === s.id ? '…' : '↻ Refresh'}</button>
          {metaConnected && <button style={{ ...mini, flex: isMobile ? 1 : undefined, padding: isMobile ? '10px 12px' : mini.padding }} onClick={() => syncMeta(s)} disabled={busyId === s.id} title="Mirror this audience to a Meta Custom Audience (hashed match)"><PlatformIcon channel="meta" size={13} /> Sync to Meta</button>}
          {metaConnected && <button style={{ ...mini, flex: isMobile ? 1 : undefined, padding: isMobile ? '10px 12px' : mini.padding, ...(s.metaAuto ? { borderColor: 'var(--brand)', color: 'var(--brand)' } : null) }} onClick={() => api.setSegmentAuto(entityId, s.id, 'meta', !s.metaAuto).then(load)} title="Keep the Meta audience mirrored automatically (~daily)"><PlatformIcon channel="meta" size={13} /> {s.metaAuto ? 'Auto: on' : 'Auto: off'}</button>}
          {tiktokConnected && <button style={{ ...mini, flex: isMobile ? 1 : undefined, padding: isMobile ? '10px 12px' : mini.padding }} onClick={() => syncTikTok(s)} disabled={busyId === s.id} title="Mirror this audience to a TikTok Custom Audience (hashed match)"><PlatformIcon channel="tiktok" size={13} /> Sync to TikTok</button>}
          {tiktokConnected && <button style={{ ...mini, flex: isMobile ? 1 : undefined, padding: isMobile ? '10px 12px' : mini.padding, ...(s.tiktokAuto ? { borderColor: 'var(--brand)', color: 'var(--brand)' } : null) }} onClick={() => api.setSegmentAuto(entityId, s.id, 'tiktok', !s.tiktokAuto).then(load)} title="Keep the TikTok audience mirrored automatically (~daily)"><PlatformIcon channel="tiktok" size={13} /> {s.tiktokAuto ? 'Auto: on' : 'Auto: off'}</button>}
          <button style={{ ...mini, flex: isMobile ? 1 : undefined, padding: isMobile ? '10px 12px' : mini.padding }} onClick={() => setEditing(s)}>Edit</button>
          <button style={{ ...mini, flex: isMobile ? 1 : undefined, padding: isMobile ? '10px 12px' : mini.padding, color: 'var(--error,#ef4444)' }} onClick={() => del(s)}>Delete</button>
        </div>
        {syncMsg[s.id]
          ? <div style={{ fontSize: 11.5, color: syncMsg[s.id].startsWith('✗') ? 'var(--error,#ef4444)' : 'var(--muted)', flexBasis: '100%', marginTop: isMobile ? 0 : 4 }}>{syncMsg[s.id]}</div>
          : (connectors.meta?.connected || connectors.tiktok?.connected || s.metaSync || s.tiktokSync) && (
            <div style={{ flexBasis: '100%', marginTop: isMobile ? 0 : 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {(connectors.meta?.connected || s.metaSync) && connLine(<PlatformIcon channel="meta" size={12} />, 'Meta', s.metaSync, connectors.meta?.audiencesUrl)}
              {(connectors.tiktok?.connected || s.tiktokSync) && connLine(<PlatformIcon channel="tiktok" size={12} />, 'TikTok', s.tiktokSync, connectors.tiktok?.audiencesUrl)}
            </div>
          )}
      </div>
    );
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>Reusable, always-live audiences — built from a dashboard tile (with filters) or a pasted list. Use them in campaigns; counts update each time. Link one to an event or a folder to keep them organised.</p>
        <button style={primary} onClick={() => setEditing('new')}>+ New segment</button>
      </div>

      {segments.length === 0 ? (
        <p style={{ color: 'var(--muted)', fontSize: 13, padding: '20px 0' }}>No segments yet. Create one from a dashboard tile or a pasted list.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Folders are now group headers below, so the only filter left is event
              (segments are grouped by folder regardless). */}
          {eventOpts.length > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 2 }}>
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Filter:</span>
              <select value={filterEvent} onChange={(e) => setFilterEvent(e.target.value)} style={orgSel} aria-label="Filter by event">
                <option value="">All events</option>
                {eventOpts.map((ev) => <option key={ev.id} value={ev.id}>🗓 {ev.name}</option>)}
              </select>
              {filterEvent && <button style={{ ...orgSel, cursor: 'pointer' }} onClick={() => setFilterEvent('')}>Clear</button>}
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{shown.length} of {segments.length}</span>
            </div>
          )}
          {grouped
            ? folderGroups.map((g) => (
              <div key={g.folder || '__unfiled'} style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
                <div style={groupHead}>
                  <span>{g.folder ? `📁 ${g.folder}` : '🗂 Unfiled'}</span>
                  <span style={{ color: 'var(--muted)', fontWeight: 600 }}>· {g.items.length}</span>
                </div>
                {g.items.map(renderCard)}
              </div>
            ))
            : shown.map(renderCard)}
        </div>
      )}

      {/* Ready to add — recipes we can auto-build from the client's data now. */}
      {RECIPE_SEGMENTS.filter((r) => !segments.some((s) => s.name === r.name)).length > 0 && (
        <div style={{ marginTop: 26 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: 10 }}>Ready to add</div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
            {RECIPE_SEGMENTS.filter((r) => !segments.some((s) => s.name === r.name)).map((r) => (
              <div key={r.key} style={{ border: '1px solid var(--hairline)', borderRadius: 14, padding: '14px 16px', background: 'var(--card)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 18 }}>{r.icon}</span>
                  <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>{r.name}</span>
                  <button style={{ ...primary, padding: '6px 14px', fontSize: 12.5 }} onClick={() => addRecipe(r)} disabled={addingKey === r.key}>{addingKey === r.key ? 'Adding…' : '+ Add'}</button>
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, lineHeight: 1.45 }}>{r.desc}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Suggested segments — visual placeholders for common audiences we'll
          auto-build from the client's data. Non-interactive (coming soon). */}
      <div style={{ marginTop: 26 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: 10 }}>Suggested segments · coming soon</div>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
          {SUGGESTED_SEGMENTS.map((s) => (
            <div key={s.name} title="Coming soon — we'll auto-build this from your data" style={{ border: '1px dashed var(--hairline)', borderRadius: 14, padding: '14px 16px', background: 'var(--card)', opacity: 0.7, cursor: 'default' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 18 }}>{s.icon}</span>
                <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>{s.name}</span>
                <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', background: 'rgba(128,128,128,0.16)', color: 'var(--muted)', borderRadius: 980, padding: '2px 7px' }}>soon</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, lineHeight: 1.45 }}>{s.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {viewing && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={() => setViewing(null)}>
          <div className="modal-in" style={{ background: 'var(--card)', borderRadius: 16, width: 'min(560px, 100%)', maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-pop)' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--hairline)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{viewing.segment.name}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{viewing.data ? (viewing.data.error ? viewing.data.error : `${viewing.data.count} ${viewing.data.count === 1 ? 'person' : 'people'}${viewing.data.capped ? ` · showing first ${(viewing.data.shown || 5000).toLocaleString()}` : ''}`) : 'Resolving live…'}</div>
              </div>
              <button style={mini} onClick={() => setViewing(null)}>Close</button>
            </div>
            <div style={{ overflowY: 'auto', padding: '4px 0' }}>
              {!viewing.data ? <div style={{ padding: 16 }}><div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 6 }}>⏳ Resolving the live audience…</div><div className="indet-track" /></div>
                : viewing.data.error ? <p style={{ color: 'var(--error,#ef4444)', fontSize: 13, padding: 16 }}>{viewing.data.error}</p>
                : viewing.data.members.length === 0 ? <p style={{ color: 'var(--muted)', fontSize: 13, padding: 16 }}>No people match right now.</p>
                : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                    <thead><tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
                      <th style={{ padding: '6px 16px', fontWeight: 600 }}>Name</th>
                      <th style={{ padding: '6px 16px', fontWeight: 600 }}>Email</th>
                      <th style={{ padding: '6px 16px', fontWeight: 600 }}>Mobile</th>
                    </tr></thead>
                    <tbody>
                      {viewing.data.members.map((m, i) => (
                        <tr key={i} style={{ borderTop: '1px solid var(--hairline)' }}>
                          <td style={{ padding: '6px 16px' }}>{m.name || '—'}</td>
                          <td style={{ padding: '6px 16px', wordBreak: 'break-all' }}>{m.email || '—'}</td>
                          <td style={{ padding: '6px 16px' }}>{m.phone || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SegmentBuilder({ entityId, tiles, segment, onClose, onSaved }) {
  const def0 = segment?.definition || {};
  // A multi-source segment stores its blocks in `sources` (block 0 is the primary,
  // edited with the full source picker; the rest are the "combine with" blocks).
  const def = (def0.sources && def0.sources.length) ? def0.sources[0] : def0;
  const [name, setName] = useState(segment?.name || '');
  const [extras, setExtras] = useState(() => ((def0.sources && def0.sources.length > 1) ? def0.sources.slice(1) : []));
  const [combine, setCombine] = useState(def0.combine || 'union');
  const [allSegments, setAllSegments] = useState([]); // saved segments available as combine blocks
  useEffect(() => { api.listSegments(entityId).then((r) => setAllSegments((r.segments || []).filter((s) => s.id !== segment?.id))).catch(() => {}); }, [entityId, segment?.id]);
  const [f, setF] = useState({
    mode: def.mode || 'tile',
    dashboardId: def.dashboardId || '', tileId: def.tileId || '',
    emailField: def.emailField || '', nameField: def.nameField || '', phoneField: def.phoneField || '',
    emailConsentField: def.emailConsentField || '', smsConsentField: def.smsConsentField || '',
    attrDashboardId: def.attrDashboardId || '', attrTileId: def.attrTileId || '',
    filters: def.filters || [], pasted: def.pasted || '', gsheetUrl: def.gsheetUrl || '',
    // Dashboard filters captured when the segment was made from a tile. Not
    // edited here, but preserved so saving doesn't silently change the cohort.
    lookerFilters: def.lookerFilters || {},
    // Live App-audience group (mode 'appmatch') — managed from the App page, but
    // preserved here so renaming/re-filing never silently drops the definition.
    group: def.group || '', appEvent: def.appEvent || '', appSize: def.appSize || 0,
  });
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  // Event/suite picker — choose the event first, then its dashboards. Distinct
  // suites from the tile catalogue (only shown for multi-event clients).
  const suiteList = (() => {
    const out = []; const seen = new Set();
    for (const d of (tiles?.dashboards || [])) { if (d.suiteId && !seen.has(d.suiteId)) { seen.add(d.suiteId); out.push({ id: d.suiteId, name: d.suiteName || d.setName || 'Event' }); } }
    return out;
  })();
  const [suiteSel, setSuiteSel] = useState('');
  // Derive the suite from an existing dashboard (when editing), or auto-pick the
  // only suite, once the catalogue has loaded.
  useEffect(() => {
    if (suiteSel) return;
    if (f.dashboardId) {
      const d = (tiles?.dashboards || []).find((x) => x.dashboardId === f.dashboardId);
      if (d?.suiteId) { setSuiteSel(d.suiteId); return; }
    }
    if (suiteList.length === 1) setSuiteSel(suiteList[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiles, f.dashboardId]);
  // A segment needs an email or mobile per person, so only offer tiles whose data
  // has a contact column — and dashboards that have at least one such tile. The
  // currently-selected tile/dashboard is always kept (so editing an older segment
  // never hides its source).
  const tileUsable = (t) => t.hasContact || t.tileId === f.tileId;
  const dashHasContact = (d) => (d.tiles || []).some(tileUsable);
  const suiteDashboards = (tiles?.dashboards || [])
    .filter((d) => !suiteSel || d.suiteId === suiteSel)
    .filter((d) => dashHasContact(d) || d.dashboardId === f.dashboardId);
  const [aud, setAud] = useState(null);
  const [audBusy, setAudBusy] = useState(false); // resolving the live count → show a progress bar
  const [busy, setBusy] = useState(false);
  const debounce = useRef();

  const primaryDef = () => ({
    mode: f.mode, dashboardId: f.dashboardId, tileId: f.tileId,
    emailField: f.emailField, nameField: f.nameField, phoneField: f.phoneField,
    emailConsentField: f.emailConsentField, smsConsentField: f.smsConsentField,
    attrDashboardId: f.attrDashboardId, attrTileId: f.attrTileId, filters: f.filters, pasted: f.pasted,
    gsheetUrl: f.gsheetUrl, lookerFilters: f.lookerFilters,
    group: f.group, appEvent: f.appEvent, appSize: f.appSize,
  });
  // Keep only fully-specified combine blocks.
  const validExtras = () => extras.filter((b) => (b.mode === 'segment' && b.segmentId) || (b.mode === 'gsheet' && (b.gsheetUrl || '').trim()) || (b.mode === 'paste' && (b.pasted || '').trim()));
  const definition = () => {
    const base = primaryDef();
    const ex = validExtras();
    return ex.length ? { ...base, sources: [base, ...ex], combine } : base;
  };
  const addExtra = () => setExtras((a) => [...a, { mode: 'segment', segmentId: '' }]);
  const removeExtra = (i) => setExtras((a) => a.filter((_, j) => j !== i));

  // Parse an uploaded CSV/Excel into the pasted-list text (SheetJS is loaded on
  // demand so it never bloats the main bundle). Stored as a 'paste' snapshot.
  const [uploadInfo, setUploadInfo] = useState('');
  // Switching source clears the column mapping so header names from one source
  // (a CSV) never silently apply to another (a tile / a different sheet).
  const pickMode = (m) => setF((s) => ({ ...s, mode: m, emailField: '', nameField: '', phoneField: '' }));
  const onFile = async (file) => {
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]] || {});
      // New file → clear any prior column mapping so it can't apply to the wrong headers.
      setF((s) => ({ ...s, mode: 'paste', pasted: csv, emailField: '', nameField: '', phoneField: '' }));
      setUploadInfo(`Loaded ${file.name}`);
    } catch (e) { alert('Could not read that file: ' + (e.message || e)); }
  };

  const refreshAud = () => {
    if (f.mode === 'tile' && (!f.dashboardId || !f.tileId)) { setAud(null); return; }
    if (f.mode === 'gsheet' && !f.gsheetUrl.trim()) { setAud(null); return; }
    setAudBusy(true);
    api.actionAudiencePreview(entityId, { audience: definition() }).then(setAud).catch((e) => setAud({ error: e.message })).finally(() => setAudBusy(false));
  };
  useEffect(() => { clearTimeout(debounce.current); debounce.current = setTimeout(refreshAud, 350); return () => clearTimeout(debounce.current); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [f.mode, f.dashboardId, f.tileId, f.emailField, f.nameField, f.phoneField, f.emailConsentField, f.smsConsentField, f.attrDashboardId, f.attrTileId, JSON.stringify(f.filters), f.pasted, f.gsheetUrl, JSON.stringify(extras), combine]);

  const addFilter = () => set('filters', [...f.filters, { field: '', op: 'in', values: [] }]);
  const setFilter = (i, patch) => set('filters', f.filters.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const removeFilter = (i) => set('filters', f.filters.filter((_, j) => j !== i));

  const save = async () => {
    if (!name.trim()) { alert('Give the segment a name.'); return; }
    setBusy(true);
    try {
      const r = segment?.id
        ? await api.updateSegment(entityId, segment.id, { name, definition: definition() })
        : await api.createSegment(entityId, { name, definition: definition() });
      // Resolve once on save so the list shows a live count immediately (a new or
      // re-defined segment is otherwise "not counted yet" until a manual refresh).
      const sid = r?.segment?.id || segment?.id;
      if (sid) await api.previewSegment(entityId, sid).catch(() => {});
      onSaved();
    } catch (e) { alert('Save failed: ' + e.message); }
    finally { setBusy(false); }
  };

  const dash = tiles?.dashboards?.find((d) => d.dashboardId === f.dashboardId);
  const dashTiles = (dash?.tiles || []).filter(tileUsable);

  return (
    <div>
      <button style={{ ...mini, marginBottom: 12 }} onClick={onClose}>← Back to segments</button>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640 }}>
        <Field label="Segment name">
          <input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. VIP buyers — Bushfire" />
        </Field>

        <Field label="Source">
          {f.mode === 'appmatch' ? (
            <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, border: '1px solid var(--hairline)', borderRadius: 10, padding: '10px 12px' }}>
              📲 <b style={{ color: 'var(--text)' }}>Live App-audience group</b> — the members are re-computed from App analytics
              (app users matched against ticket holders/buyers) every time this segment is counted or a campaign sends from it.
              The group itself is managed on the <b>App page</b>; here you can rename, re-file or combine it.
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Toggle on={f.mode === 'tile'} onClick={() => pickMode('tile')}>From a dashboard tile</Toggle>
              <Toggle on={f.mode === 'paste'} onClick={() => pickMode('paste')}>Paste / upload a list</Toggle>
              <Toggle on={f.mode === 'gsheet'} onClick={() => pickMode('gsheet')}>Link a Google Sheet</Toggle>
            </div>
          )}
        </Field>

        {f.mode === 'appmatch' ? null : f.mode === 'tile' ? (
          <Field label="Audience">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {suiteList.length > 1 && (
                <select style={input} value={suiteSel} onChange={(e) => { setSuiteSel(e.target.value); set('dashboardId', ''); set('tileId', ''); set('emailField', ''); }}>
                  <option value="">Pick an event…</option>
                  {suiteList.map((s) => <option key={s.id} value={s.id}>🗓 {s.name}</option>)}
                </select>
              )}
              <select style={input} value={f.dashboardId} disabled={suiteList.length > 1 && !suiteSel} onChange={(e) => { set('dashboardId', e.target.value); set('tileId', ''); set('emailField', ''); }}>
                <option value="">{suiteList.length > 1 && !suiteSel ? 'Pick an event first…' : 'Pick a dashboard…'}</option>
                {suiteDashboards.map((d) => <option key={d.dashboardId} value={d.dashboardId}>{d.title} — {d.setName}</option>)}
              </select>
              {dash && (
                <select style={input} value={f.tileId} onChange={(e) => { set('tileId', e.target.value); set('emailField', ''); }}>
                  <option value="">Pick the tile listing the people…</option>
                  {dashTiles.map((t) => <option key={t.tileId} value={t.tileId}>{t.title}</option>)}
                </select>
              )}
              {dash && dashTiles.length === 0 && <div style={hintS}>No tiles on this dashboard expose an email or mobile column, so there's no one to build a segment from here.</div>}
              {aud?.fields?.length > 0 && (
                <>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <select style={{ ...input, flex: 1 }} value={f.emailField} onChange={(e) => set('emailField', e.target.value)}>
                      <option value="">Email column (auto-detect)</option>
                      {aud.fields.map((fl) => <option key={fl.name} value={fl.name}>{fl.label}</option>)}
                    </select>
                    <select style={{ ...input, flex: 1 }} value={f.nameField} onChange={(e) => set('nameField', e.target.value)}>
                      <option value="">Name column (optional)</option>
                      {aud.fields.map((fl) => <option key={fl.name} value={fl.name}>{fl.label}</option>)}
                    </select>
                  </div>
                  <select style={input} value={f.phoneField} onChange={(e) => set('phoneField', e.target.value)}>
                    <option value="">Mobile-number column (optional — for SMS)</option>
                    {aud.fields.map((fl) => <option key={fl.name} value={fl.name}>{fl.label}</option>)}
                  </select>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <select style={{ ...input, flex: 1 }} value={f.emailConsentField} onChange={(e) => set('emailConsentField', e.target.value)}>
                      <option value="">Email consent column (optional)</option>
                      {aud.fields.map((fl) => <option key={fl.name} value={fl.name}>{fl.label}</option>)}
                    </select>
                    <select style={{ ...input, flex: 1 }} value={f.smsConsentField} onChange={(e) => set('smsConsentField', e.target.value)}>
                      <option value="">SMS consent column (optional)</option>
                      {aud.fields.map((fl) => <option key={fl.name} value={fl.name}>{fl.label}</option>)}
                    </select>
                  </div>
                  <div style={hintS}>Set the consent columns to see real reach — emailable / SMS-opted-in. Consent is enforced per channel when a campaign sends (a campaign can override for transactional messages).</div>
                  <AudienceFilters entityId={entityId}
                    fields={(aud.filterFields && aud.filterFields.length) ? aud.filterFields : aud.fields.map((fl) => ({ ...fl, dashboardId: f.dashboardId, tileId: f.tileId }))}
                    filters={f.filters} addFilter={addFilter} setFilter={setFilter} removeFilter={removeFilter}
                    attr={{ dashboardId: f.attrDashboardId, tileId: f.attrTileId }}
                    tiles={tiles} onAttr={(dashboardId, tileId) => { set('attrDashboardId', dashboardId); set('attrTileId', tileId); }} />
                </>
              )}
            </div>
          </Field>
        ) : f.mode === 'gsheet' ? (
          <Field label="Google Sheet link">
            <input style={input} value={f.gsheetUrl} onChange={(e) => set('gsheetUrl', e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=0" onBlur={refreshAud} />
            <div style={hintS}>The sheet must be shared <b>“Anyone with the link”</b> (or published to the web). We read it <b>live</b> each time — auto-detecting the email, mobile and name, or use <b>Match columns</b> below to pin them by header.</div>
          </Field>
        ) : (
          <Field label="Paste a list, or upload a CSV / Excel file">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
              <label style={{ ...mini, cursor: 'pointer' }}>📄 Upload CSV / Excel
                <input type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }} onChange={(e) => { const file = e.target.files?.[0]; if (file) onFile(file); e.target.value = ''; }} />
              </label>
              {uploadInfo && <span style={hintS}>{uploadInfo}</span>}
            </div>
            <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={4} value={f.pasted} onChange={(e) => { set('pasted', e.target.value); setUploadInfo(''); }} placeholder="one@example.com, +27821234567, two@example.com …" onBlur={refreshAud} />
            <div style={hintS}>One person per line — we auto-detect the email, mobile and name. For a spreadsheet with headers, use <b>Match columns</b> below to pin which column is which. Numbers become SMS-reachable; emails email-reachable.</div>
          </Field>
        )}

        {(f.mode === 'paste' || f.mode === 'gsheet') && aud?.columns?.length > 0 && (
          <Field label="Match columns (optional)">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <select style={{ ...input, flex: 1 }} value={f.emailField} onChange={(e) => set('emailField', e.target.value)}>
                  <option value="">Email column (auto-detect)</option>
                  {aud.columns.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <select style={{ ...input, flex: 1 }} value={f.nameField} onChange={(e) => set('nameField', e.target.value)}>
                  <option value="">Name column (optional)</option>
                  {aud.columns.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <select style={input} value={f.phoneField} onChange={(e) => set('phoneField', e.target.value)}>
                <option value="">Mobile-number column (auto-detect)</option>
                {aud.columns.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <div style={hintS}>Tell us which columns hold the email, name and mobile — useful when a row has several number-like values. Leave on <b>auto-detect</b> to let us guess from each row.</div>
              {aud?.filterFields?.length > 0 && (
                <AudienceFilters entityId={entityId} fields={aud.filterFields}
                  filters={f.filters} addFilter={addFilter} setFilter={setFilter} removeFilter={removeFilter} hideAttrSource />
              )}
            </div>
          </Field>
        )}

        {/* Multi-source: combine the primary source above with other sources. */}
        <Field label="Combine with other sources (optional)">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {extras.map((b, i) => (
              <ExtraBlock key={i} entityId={entityId} block={b} allSegments={allSegments}
                onChange={(nb) => setExtras((a) => a.map((x, j) => (j === i ? nb : x)))} onRemove={() => removeExtra(i)} />
            ))}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" style={mini} onClick={addExtra}>＋ Add a source</button>
              {extras.length > 0 && (
                <select value={combine} onChange={(e) => setCombine(e.target.value)} style={{ ...input, width: 'auto', flex: '0 0 auto' }}>
                  <option value="union">Union — anyone in any source</option>
                  <option value="intersect">Intersect — only people in every source</option>
                  <option value="exclude">Exclude — in the main source, not the others</option>
                </select>
              )}
            </div>
            {extras.length > 0 && (
              <div style={hintS}>The primary source above is the main one. {combine === 'exclude' ? 'Exclude removes anyone who also appears in the sources below — great for suppression.' : combine === 'intersect' ? 'Intersect keeps only people in the main source AND every source below.' : 'Union merges everyone across all sources (deduped by email/mobile).'}</div>
            )}
          </div>
        </Field>

        {audBusy ? (
          <div style={{ fontSize: 13 }}>
            <div style={{ color: 'var(--muted)', marginBottom: 5 }}>⏳ Resolving the live audience…</div>
            <div className="indet-track" />
          </div>
        ) : (
          <div style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {aud?.error ? <span style={{ color: 'var(--error,#ef4444)' }}>✗ {aud.error}</span>
              : aud ? <span><b style={{ color: 'var(--brand)' }}>{aud.count}</b> {aud.count === 1 ? 'person' : 'people'} match{aud.reach ? ` · ${aud.reach.email} emailable · ${aud.reach.sms} SMS` : ''}{aud.filteredOut > 0 ? ` · ${aud.filteredOut} filtered out` : ''}</span>
                : <span style={{ color: 'var(--muted)' }}>Pick a source to see the live count.</span>}
            {/* Re-read the live source now (e.g. a linked Google Sheet edited since). */}
            {aud && !aud.error && (
              <button type="button" style={{ ...mini, padding: '3px 9px' }} onClick={refreshAud} title="Re-read the live source (e.g. a linked Google Sheet) and recount now">↻ Refresh</button>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          <button style={primary} onClick={save} disabled={busy}>{busy ? 'Saving…' : segment ? 'Save changes' : 'Create segment'}</button>
          <button style={mini} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// One "combine with" source block: picks its type + source, and (for a Sheet or
// uploaded/pasted list) lets you pin its email/mobile columns and add its OWN
// targeting filters — resolved independently, then merged by the combine rule.
function ExtraBlock({ entityId, block, allSegments, onChange, onRemove }) {
  const b = block;
  const setB = (patch) => onChange({ ...b, ...patch });
  const [aud, setAud] = useState(null);
  const debounce = useRef();
  const fileFields = b.mode === 'gsheet' || b.mode === 'paste';
  useEffect(() => {
    clearTimeout(debounce.current);
    const ready = (b.mode === 'segment' && b.segmentId) || (b.mode === 'gsheet' && (b.gsheetUrl || '').trim()) || (b.mode === 'paste' && (b.pasted || '').trim());
    if (!ready) { setAud(null); return; }
    debounce.current = setTimeout(() => {
      api.actionAudiencePreview(entityId, { audience: b }).then(setAud).catch((e) => setAud({ error: e.message }));
    }, 350);
    return () => clearTimeout(debounce.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, b.mode, b.segmentId, b.gsheetUrl, b.pasted, b.emailField, b.phoneField, JSON.stringify(b.filters)]);
  const onFile = async (file) => {
    try { const XLSX = await import('xlsx'); const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' }); setB({ mode: 'paste', pasted: XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]] || {}) }); }
    catch (e) { alert('Could not read that file: ' + (e.message || e)); }
  };
  const addFilter = () => setB({ filters: [...(b.filters || []), { field: '', op: 'in', values: [] }] });
  const setFilter = (i, p) => setB({ filters: (b.filters || []).map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const removeFilter = (i) => setB({ filters: (b.filters || []).filter((_, j) => j !== i) });
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={b.mode} onChange={(e) => onChange({ mode: e.target.value, segmentId: '', gsheetUrl: '', pasted: '', emailField: '', nameField: '', phoneField: '', filters: [] })} style={{ ...input, flex: '0 0 140px' }}>
          <option value="segment">Saved segment</option>
          <option value="gsheet">Google Sheet</option>
          <option value="paste">Paste / upload</option>
        </select>
        {b.mode === 'segment' ? (
          <select value={b.segmentId || ''} onChange={(e) => setB({ segmentId: e.target.value })} style={{ ...input, flex: 1, minWidth: 160 }}>
            <option value="">Pick a segment…</option>
            {allSegments.map((s) => <option key={s.id} value={s.id}>{s.name}{s.count >= 0 ? ` (${s.count})` : ''}</option>)}
          </select>
        ) : b.mode === 'gsheet' ? (
          <input value={b.gsheetUrl || ''} onChange={(e) => setB({ gsheetUrl: e.target.value })} placeholder="Google Sheet link" style={{ ...input, flex: 1, minWidth: 160 }} />
        ) : (
          <div style={{ display: 'flex', gap: 6, flex: 1, minWidth: 160, alignItems: 'center' }}>
            <label style={{ ...mini, cursor: 'pointer', flexShrink: 0 }}>📄 Upload
              <input type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }} onChange={(e) => { const file = e.target.files?.[0]; if (file) onFile(file); e.target.value = ''; }} />
            </label>
            {/\n/.test(b.pasted || '')
              ? <span style={{ ...hintS, marginTop: 0, flex: 1 }}>✓ List loaded ({(b.pasted.match(/\n/g) || []).length} rows) <button type="button" style={{ ...mini, padding: '2px 8px', marginLeft: 4 }} onClick={() => setB({ pasted: '' })}>Clear</button></span>
              : <input value={b.pasted || ''} onChange={(e) => setB({ pasted: e.target.value })} placeholder="emails / numbers, or upload a file" style={{ ...input, flex: 1 }} />}
          </div>
        )}
        <button type="button" style={{ ...mini, color: 'var(--error,#ef4444)' }} onClick={onRemove}>✕</button>
      </div>
      {/* Column match + filters for a list source (so you can target this block too). */}
      {fileFields && aud?.columns?.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <select value={b.emailField || ''} onChange={(e) => setB({ emailField: e.target.value })} style={{ ...input, flex: 1, minWidth: 120, padding: '6px 8px' }}>
            <option value="">Email column (auto-detect)</option>
            {aud.columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={b.nameField || ''} onChange={(e) => setB({ nameField: e.target.value })} style={{ ...input, flex: 1, minWidth: 120, padding: '6px 8px' }}>
            <option value="">Name column (optional)</option>
            {aud.columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={b.phoneField || ''} onChange={(e) => setB({ phoneField: e.target.value })} style={{ ...input, flex: 1, minWidth: 120, padding: '6px 8px' }}>
            <option value="">Mobile column (auto-detect)</option>
            {aud.columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      )}
      {fileFields && aud?.columns?.length > 0 && !(aud?.filterFields?.length > 0) && (
        <div style={hintS}>Pick the email or mobile column above to filter this list by its other columns (ticket type, city…).</div>
      )}
      {fileFields && aud?.filterFields?.length > 0 && (
        <AudienceFilters entityId={entityId} fields={aud.filterFields} filters={b.filters || []} addFilter={addFilter} setFilter={setFilter} removeFilter={removeFilter} hideAttrSource />
      )}
      {aud && (
        <div style={{ ...hintS, marginTop: 0 }}>
          {aud.error ? <span style={{ color: 'var(--error,#ef4444)' }}>✗ {aud.error}</span>
            : <span><b style={{ color: 'var(--brand)' }}>{aud.count}</b> in this source{aud.filteredOut > 0 ? ` · ${aud.filteredOut} filtered out` : ''}</span>}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) { return <div><div style={lbl}>{label}</div>{children}</div>; }
function Toggle({ on, onClick, children }) {
  return <button type="button" onClick={onClick} style={{ flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: on ? '1.5px solid var(--brand)' : '1.5px solid var(--hairline)', background: on ? 'rgba(var(--brand-rgb,255,56,92),0.08)' : 'transparent', color: on ? 'var(--brand)' : 'var(--text)' }}>{children}</button>;
}

const input = { width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', background: 'var(--card)', color: 'var(--text)' };
const mini = { padding: '7px 12px', borderRadius: 8, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' };
const primary = { padding: '9px 18px', borderRadius: 980, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const hintS = { fontSize: 11.5, color: 'var(--muted)', marginTop: 4 };
const lbl = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted)', marginBottom: 5 };
