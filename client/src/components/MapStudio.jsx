import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useProfile } from '../lib/profile.jsx';

// Map Studio — build & publish the event map yourself (docs/MAP_STUDIO_SPEC.md).
// Dual-surface: <MapStudio scope="admin" entityId=…/> under Admin → client → Map
// Studio, and <MapStudio scope="my" entityId=…/> on the client's /event-map page.
// The centre is a live preview iframe (the REAL public map page in edit mode);
// the editor talks to it via postMessage: click-to-place, drag-to-move, camera
// capture. Publish snapshots the draft to /maps/:slug — that URL goes into the
// Howler app's per-event map WebView field.

export default function MapStudio({ entityId, scope = 'my' }) {
  const [suites, setSuites] = useState(null);
  const [suiteId, setSuiteId] = useState('');

  useEffect(() => {
    if (!entityId) return;
    let alive = true;
    api.mapstudioSuites(entityId)
      .then((r) => { if (!alive) return; setSuites(r.suites || []); setSuiteId((cur) => cur || (r.suites?.[0]?.id || '')); })
      .catch(() => alive && setSuites([]));
    return () => { alive = false; };
  }, [entityId]);

  if (suites === null) return <div style={{ padding: 24, color: 'var(--muted)' }}>Loading Map Studio…</div>;
  if (!suites.length) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>No events yet — add a suite to this client first, then build its map here.</p>;

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Event</label>
        <select value={suiteId} onChange={(e) => setSuiteId(e.target.value)} style={sel}>
          {suites.map((s) => <option key={s.id} value={s.id}>{s.name}{s.published ? ' · published' : ''}</option>)}
        </select>
      </div>
      {suiteId && <Editor key={suiteId} suiteId={suiteId} scope={scope} />}
    </div>
  );
}

function Editor({ suiteId, scope }) {
  const isMobile = useIsMobile();
  const { isAdmin } = useProfile();
  const [data, setData] = useState(null);          // { config, places, tokenSet, canManage }
  const [selId, setSelId] = useState('');
  const [addMode, setAddMode] = useState(false);
  const [busy, setBusy] = useState('');
  const [analytics, setAnalytics] = useState(null);
  const [showCats, setShowCats] = useState(false);
  const [showStats, setShowStats] = useState(false);
  // Published maps open LOCKED (safe to browse on a phone, nothing can move);
  // Edit map consciously re-enters edit mode. null = not decided yet (loading).
  const [unlocked, setUnlocked] = useState(null);
  const [iframeKey, setIframeKey] = useState(0);   // bump to reload preview (style change)
  const frameRef = useRef(null);
  const readyRef = useRef(false);
  const stateRef = useRef({ data: null, selId: '', addMode: false, unlocked: null });
  stateRef.current = { data, selId, addMode, unlocked };

  const load = useCallback(() => api.mapstudioGet(suiteId).then((d) => {
    setData(d);
    setUnlocked((cur) => (cur === null ? !d.config.published : cur));
  }).catch((e) => alert(e.message)), [suiteId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (data?.config?.published) api.mapstudioAnalytics(suiteId).then(setAnalytics).catch(() => {});
  }, [suiteId, data?.config?.published, data?.config?.version]);

  // ── preview bridge ────────────────────────────────────────────────────────────
  const post = useCallback((msg) => {
    frameRef.current?.contentWindow?.postMessage({ src: 'mapstudio-editor', ...msg }, window.location.origin);
  }, []);
  const sendState = useCallback((d = stateRef.current.data, sid = stateRef.current.selId) => {
    if (!d || !readyRef.current) return;
    const locked = !(d.canManage && stateRef.current.unlocked === true);
    post({ type: 'state', config: { ...d.config, places: d.places }, selectedId: sid, locked, openSheet: false });
  }, [post]);
  useEffect(() => { sendState(); }, [data, selId, unlocked, sendState]);

  useEffect(() => {
    async function onMsg(e) {
      if (e.origin !== window.location.origin || e.data?.src !== 'mapstudio-preview') return;
      const { data: d, addMode: adding } = stateRef.current;
      if (e.data.type === 'ready') { readyRef.current = true; sendState(); }
      if (e.data.type === 'poi:selected') setSelId(e.data.id);
      if (e.data.type === 'poi:moved') {
        try {
          const r = await api.mapstudioUpdatePlace(suiteId, e.data.id, { lat: e.data.lat, lng: e.data.lng });
          setData((cur) => cur && ({ ...cur, places: cur.places.map((p) => (p.id === r.place.id ? r.place : p)) }));
        } catch (err) { alert(err.message); }
      }
      if (e.data.type === 'map:click' && adding && d?.canManage && stateRef.current.unlocked === true) {
        setAddMode(false);
        try {
          const r = await api.mapstudioCreatePlace(suiteId, { name: 'New place', kind: d.config.categories[0]?.key, lat: e.data.lat, lng: e.data.lng });
          setData((cur) => cur && ({ ...cur, places: [...cur.places, r.place] }));
          setSelId(r.place.id);
        } catch (err) { alert(err.message); }
      }
      if (e.data.type === 'camera') {
        try {
          const r = await api.mapstudioSaveConfig(suiteId, { camera: { lat: e.data.lat, lng: e.data.lng, zoom: e.data.zoom, pitch: e.data.pitch, bearing: e.data.bearing } });
          setData((cur) => cur && ({ ...cur, config: { ...cur.config, camera: r.config.camera } }));
          setBusy('');
        } catch (err) { setBusy(''); alert(err.message); }
      }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [suiteId, sendState]);

  if (!data) return <div style={{ padding: 24, color: 'var(--muted)' }}>Loading map…</div>;
  const { config, places, tokenSet, canManage } = data;
  const canEdit = canManage && unlocked === true;
  const selected = places.find((p) => p.id === selId) || null;
  const publicUrl = config.publicPath ? window.location.origin + config.publicPath : '';

  async function publish() {
    setBusy('publish');
    try { const r = await api.mapstudioPublish(suiteId); setData((cur) => ({ ...cur, config: r.config })); }
    catch (e) { alert(e.message); }
    setBusy('');
  }
  async function importStations() {
    setBusy('import');
    try {
      const r = await api.mapstudioImportStations(suiteId);
      if (r.places) setData((cur) => ({ ...cur, places: r.places }));
      alert(r.stations ? `Imported ${r.imported} of ${r.stations} Event Ops stations — drag their pins into position.` : 'No Event Ops stations found for this event.');
    } catch (e) { alert(e.message); }
    setBusy('');
  }
  async function setStyle(style) {
    try {
      const r = await api.mapstudioSaveConfig(suiteId, { style });
      setData((cur) => ({ ...cur, config: { ...cur.config, style: r.config.style } }));
      setIframeKey((k) => k + 1); // style lives in the page boot — reload preview
    } catch (e) { alert(e.message); }
  }

  const preview = (
    <div style={{ position: 'relative', borderRadius: 14, overflow: 'hidden', border: '1px solid var(--hairline)', background: '#101418', minHeight: isMobile ? 420 : 560 }}>
      <iframe
        key={iframeKey}
        ref={frameRef}
        title="Map preview"
        src={`/api/mapstudio/suites/${suiteId}/preview`}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none' }}
        onLoad={() => { readyRef.current = true; sendState(); }}
      />
      {canEdit && (
        <button onClick={() => setAddMode((v) => !v)} style={{ ...addBtn, background: addMode ? 'var(--brand)' : 'rgba(20,24,29,0.85)' }}>
          {addMode ? 'Tap the map to drop the pin…' : '+ Add place'}
        </button>
      )}
    </div>
  );

  return (
    <div>
      {/* find the venue: search or paste coordinates, then frame + Save this view */}
      {canEdit && (
        <VenueSearch
          token={data.token}
          near={config.camera && Number.isFinite(config.camera.lat) ? config.camera : null}
          onGo={({ lat, lng, name }) => {
            post({ type: 'camera:set', camera: { lat, lng, zoom: 16, pitch: 0, bearing: 0 } });
            if (name) post({ type: 'fly', lat, lng });
          }}
        />
      )}
      {/* top bar: lock/edit, style, camera, import, stats, publish */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        {canManage && config.published && (
          unlocked
            ? <button style={btn} onClick={() => { setAddMode(false); setUnlocked(false); }}>✅ Done — lock map</button>
            : <button style={{ ...btn, fontWeight: 700 }} onClick={() => setUnlocked(true)}>🔒 Published · locked — Edit map</button>
        )}
        {canEdit && (
          <>
            <select value={config.style} onChange={(e) => setStyle(e.target.value)} style={sel}>
              <option value="dark">Dark</option><option value="satellite">Satellite</option>
              <option value="streets">Streets</option><option value="outdoors">Outdoors</option><option value="standard">3D (Standard)</option>
            </select>
            <button style={btn} disabled={busy === 'camera'} onClick={() => { setBusy('camera'); post({ type: 'camera:get' }); }}>📷 Save this view</button>
            <button style={btn} disabled={busy === 'import'} onClick={importStations}>⇄ Import Event Ops stations</button>
            <button style={btn} onClick={() => setShowCats((v) => !v)}>🏷 Categories ({config.categories.length})</button>
          </>
        )}
        {config.published && <button style={btn} onClick={() => setShowStats((v) => !v)}>📊 Map stats</button>}
        <span style={{ flex: 1 }} />
        {canEdit && (
          <button style={{ ...btn, background: 'var(--brand)', color: '#fff', border: 'none', fontWeight: 700 }} disabled={busy === 'publish'} onClick={publish}>
            {busy === 'publish' ? 'Publishing…' : config.published ? `Republish (v${config.version})` : 'Publish map'}
          </button>
        )}
      </div>

      {!tokenSet && (
        <div style={note}>
          <b>No Mapbox token yet</b> — the preview shows the place list without a basemap.{' '}
          {isAdmin ? <TokenSetter onSet={() => { load(); setIframeKey((k) => k + 1); }} /> : 'Ask Howler to add the Mapbox public token in Admin → any client → Map Studio.'}
        </div>
      )}

      {config.published && publicUrl && (
        <div style={note}>
          <b>Live:</b>{' '}
          <a href={publicUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--brand)', wordBreak: 'break-all' }}>{publicUrl}</a>
          <button style={{ ...btn, padding: '4px 10px', fontSize: 12, marginLeft: 8 }} onClick={() => navigator.clipboard?.writeText(publicUrl)}>Copy</button>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
            Paste this URL into the event's <b>map link</b> in Howler admin (mobileAppConfiguration → mapboxUrl) and the app shows it — republish any time, it updates live.
          </div>
        </div>
      )}

      {canEdit && (
        <EventLink
          suiteId={suiteId}
          config={config}
          onSaved={(cfg) => setData((c) => ({ ...c, config: { ...c.config, ...cfg } }))}
        />
      )}
      {canEdit && (
        <ExternalMapUrl
          suiteId={suiteId}
          config={config}
          onSaved={(cfg) => setData((c) => ({ ...c, config: { ...c.config, ...cfg } }))}
        />
      )}

      {showCats && canEdit && <CategoriesEditor suiteId={suiteId} config={config} canManage={canEdit} onClose={() => setShowCats(false)} onSaved={(cfg) => { setData((c) => ({ ...c, config: { ...c.config, ...cfg } })); }} />}

      {showStats && analytics && (
        <div style={{ ...card, marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: 8 }}>Map stats · last {analytics.sinceDays} days</div>
          <div style={{ display: 'flex', gap: 16, fontSize: 13, flexWrap: 'wrap' }}>
            <span><b>{analytics.opens}</b> opens</span>
            <span><b>{analytics.poiTaps}</b> place taps</span>
            <span><b>{analytics.ctaClicks}</b> CTA clicks</span>
          </div>
          {analytics.topPlaces.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {analytics.topPlaces.map((t) => (
                <div key={t.placeId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '3px 0', borderTop: '1px solid var(--hairline)' }}>
                  <span>{t.name}</span><span style={{ color: 'var(--muted)' }}>{t.taps} taps</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* main layout: preview + side panel (stacked on mobile) */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1fr) 360px', gap: 14, alignItems: 'start' }}>
        {preview}
        <div>
          <PlaceList places={places} categories={config.categories} selId={selId} onSelect={(id) => { setSelId(id); const p = places.find((x) => x.id === id); if (p) post({ type: 'fly', lat: p.lat, lng: p.lng }); }} />
          {selected && (
            <PlaceForm
              key={selected.id}
              suiteId={suiteId}
              place={selected}
              categories={config.categories}
              canManage={canEdit}
              onSaved={(pl) => setData((cur) => ({ ...cur, places: cur.places.map((p) => (p.id === pl.id ? pl : p)) }))}
              onDeleted={(id) => { setData((cur) => ({ ...cur, places: cur.places.filter((p) => p.id !== id) })); setSelId(''); }}
            />
          )}
          {!selected && (
            <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 10 }}>
              {canEdit
                ? 'Select a place to edit it, or use “+ Add place” and tap the map.'
                : canManage && config.published
                  ? 'This map is published and locked — hit “Edit map” above to make changes.'
                  : 'Select a place to view it.'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function PlaceList({ places, categories, selId, onSelect }) {
  const catOf = (k) => categories.find((c) => c.key === k) || { color: '#8899aa', label: k };
  return (
    <div style={{ ...card, maxHeight: 260, overflow: 'auto' }}>
      <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: 6 }}>Places · {places.length}</div>
      {places.length === 0 && <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>Nothing yet — add your stages, bars, gates and facilities.</p>}
      {places.map((p) => (
        <button key={p.id} onClick={() => onSelect(p.id)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 8px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, color: 'var(--text)', background: p.id === selId ? 'rgba(255,56,92,0.08)' : 'none', minHeight: 40 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: catOf(p.kind).color, flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: p.id === selId ? 700 : 500 }}>{p.name}</span>
          {p.stationId && <span title="Linked to an Event Ops station" style={{ fontSize: 10 }}>📟</span>}
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{catOf(p.kind).label}</span>
        </button>
      ))}
    </div>
  );
}

function PlaceForm({ suiteId, place, categories, canManage, onSaved, onDeleted }) {
  const [f, setF] = useState({ ...place });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((cur) => ({ ...cur, [k]: v }));
  const dirty = JSON.stringify(f) !== JSON.stringify(place);

  async function save() {
    setBusy(true);
    try { const r = await api.mapstudioUpdatePlace(suiteId, place.id, f); onSaved(r.place); }
    catch (e) { alert(e.message); }
    setBusy(false);
  }
  async function del() {
    if (!window.confirm(`Delete “${place.name}” from the map?`)) return;
    try { await api.mapstudioDeletePlace(suiteId, place.id); onDeleted(place.id); }
    catch (e) { alert(e.message); }
  }
  function onLogoFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    // downscale to a small circle-friendly square so the data-URL stays tiny
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      const s = 192; c.width = s; c.height = s;
      const ctx = c.getContext('2d');
      const m = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, s, s);
      set('logo', c.toDataURL('image/png'));
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
    e.target.value = '';
  }

  return (
    <div style={{ ...card, marginTop: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: 8 }}>Edit place</div>
      <label style={lbl}>Name</label>
      <input style={inp} value={f.name} onChange={(e) => set('name', e.target.value)} disabled={!canManage} maxLength={80} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 76px 86px', gap: 8 }}>
        <div>
          <label style={lbl}>Category</label>
          <select style={{ ...inp, width: '100%' }} value={f.kind} onChange={(e) => set('kind', e.target.value)} disabled={!canManage}>
            {categories.map((c) => <option key={c.key} value={c.key}>{c.icon} {c.label}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl}>Icon</label>
          <input style={inp} value={f.icon} placeholder="emoji" onChange={(e) => set('icon', e.target.value)} disabled={!canManage} maxLength={8} />
        </div>
        <div>
          <label style={lbl}>Pin size</label>
          <select style={{ ...inp, width: '100%' }} value={f.size || 'm'} onChange={(e) => set('size', e.target.value)} disabled={!canManage}>
            <option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option>
          </select>
        </div>
      </div>
      <label style={lbl}>Logo (shown as the pin — e.g. a sponsor logo)</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {f.logo
          ? <img src={f.logo} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', border: '1px solid var(--hairline)', background: '#fff' }} />
          : <span style={{ fontSize: 12, color: 'var(--muted)' }}>None — uses the category icon</span>}
        {canManage && (
          <>
            <label style={{ ...btn, padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}>
              Upload<input type="file" accept="image/*" style={{ display: 'none' }} onChange={onLogoFile} />
            </label>
            {f.logo && <button style={{ ...btn, padding: '6px 12px', fontSize: 12 }} onClick={() => set('logo', '')}>Remove</button>}
          </>
        )}
      </div>
      <label style={lbl}>Description</label>
      <textarea style={{ ...inp, minHeight: 64, resize: 'vertical' }} value={f.description} onChange={(e) => set('description', e.target.value)} disabled={!canManage} maxLength={600} placeholder="What attendees should know — hours, payment, tips…" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div>
          <label style={lbl}>Button label</label>
          <input style={inp} value={f.ctaLabel} onChange={(e) => set('ctaLabel', e.target.value)} disabled={!canManage} maxLength={40} placeholder="Order a drink" />
        </div>
        <div>
          <label style={lbl}>Button link</label>
          <input style={inp} value={f.ctaUrl} onChange={(e) => set('ctaUrl', e.target.value)} disabled={!canManage} maxLength={600} placeholder="https://… or app link" />
        </div>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, margin: '10px 0' }}>
        <input type="checkbox" checked={f.showInFilters !== false} onChange={(e) => set('showInFilters', e.target.checked)} disabled={!canManage} />
        Show in map filters
      </label>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>
        {Number(place.lat).toFixed(5)}, {Number(place.lng).toFixed(5)} · drag the pin on the map to move it
        {place.stationId ? ' · linked to its Event Ops station 📟' : ''}
      </div>
      {canManage && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={{ ...btn, flex: 1, background: dirty ? 'var(--brand)' : 'var(--card)', color: dirty ? '#fff' : 'var(--text)', fontWeight: 700 }} disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save place'}</button>
          <button style={{ ...btn, color: '#d70015' }} onClick={del}>Delete</button>
        </div>
      )}
    </div>
  );
}

function CategoriesEditor({ suiteId, config, canManage, onClose, onSaved }) {
  const [cats, setCats] = useState(config.categories.map((c) => ({ ...c })));
  const [busy, setBusy] = useState(false);
  const set = (i, k, v) => setCats((cur) => cur.map((c, j) => (i === j ? { ...c, [k]: v } : c)));
  async function save() {
    setBusy(true);
    try { const r = await api.mapstudioSaveConfig(suiteId, { categories: cats }); onSaved(r.config); onClose?.(); }
    catch (e) { alert(e.message); }
    setBusy(false);
  }
  return (
    <div style={{ ...card, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }}>Categories — these become the filter chips</div>
        <button onClick={() => onClose?.()} aria-label="Close categories" style={{ ...btn, marginLeft: 'auto', padding: '4px 10px', fontSize: 12 }}>✕ Close</button>
      </div>
      {cats.map((c, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
          <input style={{ ...inp, width: 52, marginBottom: 0, textAlign: 'center' }} value={c.icon} onChange={(e) => set(i, 'icon', e.target.value)} disabled={!canManage} maxLength={8} />
          <input style={{ ...inp, flex: 1, marginBottom: 0 }} value={c.label} onChange={(e) => set(i, 'label', e.target.value)} disabled={!canManage} maxLength={40} />
          <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(c.color) ? c.color : '#8899aa'} onChange={(e) => set(i, 'color', e.target.value)} disabled={!canManage} style={{ width: 36, height: 32, border: 'none', background: 'none', cursor: 'pointer' }} />
          {canManage && <button style={{ ...btn, padding: '4px 9px', fontSize: 12 }} onClick={() => setCats((cur) => cur.filter((_, j) => j !== i))}>✕</button>}
        </div>
      ))}
      {canManage && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button style={btn} onClick={() => setCats((cur) => [...cur, { key: `cat${Date.now() % 100000}`, label: 'New category', color: '#8899aa', icon: '📍' }])}>+ Add</button>
          <button style={{ ...btn, background: 'var(--brand)', color: '#fff', border: 'none', fontWeight: 700 }} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save categories'}</button>
        </div>
      )}
    </div>
  );
}

function EventLink({ suiteId, config, onSaved }) {
  const [id, setId] = useState(config.howlerEventId || '');
  const [busy, setBusy] = useState(false);
  const saved = (config.howlerEventId || '') === id.trim();
  return (
    <div style={{ ...note, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ minWidth: 0, flex: '1 1 260px' }}>
        <b>Howler app link</b>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
          Enter the Howler <b>event ID</b> (the number in the Active Admin event URL, e.g. 7701). The app then finds this map by itself — no admin field to update, ever.
        </div>
      </div>
      <input
        style={{ ...inp, marginBottom: 0, width: 120 }}
        value={id}
        inputMode="numeric"
        placeholder="e.g. 7701"
        onChange={(e) => setId(e.target.value.replace(/\D/g, ''))}
      />
      <button
        style={{ ...btn, fontWeight: 600 }}
        disabled={busy || saved}
        onClick={async () => {
          setBusy(true);
          try { const r = await api.mapstudioSaveConfig(suiteId, { howlerEventId: id.trim() }); onSaved(r.config); }
          catch (e) { alert(e.message); }
          setBusy(false);
        }}
      >
        {busy ? 'Saving…' : saved ? (id ? 'Linked ✓' : 'Not linked') : 'Save link'}
      </button>
    </div>
  );
}

function ExternalMapUrl({ suiteId, config, onSaved }) {
  const [url, setUrl] = useState(config.externalUrl || '');
  const [busy, setBusy] = useState(false);
  const saved = (config.externalUrl || '') === url.trim();
  async function save(next) {
    setBusy(true);
    try { const r = await api.mapstudioSaveConfig(suiteId, { externalUrl: next }); onSaved(r.config); setUrl(r.config.externalUrl || ''); }
    catch (e) { alert(e.message); }
    setBusy(false);
  }
  return (
    <div style={{ ...note, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ minWidth: 0, flex: '1 1 260px' }}>
        <b>Outsourced map?</b>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
          If a professional built this event's map elsewhere, paste its URL — publishing then points the app (and /maps link) at it instead of the studio map. Leave blank to use the studio map.
        </div>
      </div>
      <input style={{ ...inp, marginBottom: 0, flex: '1 1 240px' }} value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} />
      <button style={{ ...btn, fontWeight: 600 }} disabled={busy || saved} onClick={() => save(url.trim())}>
        {busy ? 'Saving…' : saved ? (url ? 'External map ✓' : 'Using studio map') : 'Save'}
      </button>
      {config.externalUrl && <button style={{ ...btn, fontSize: 12 }} disabled={busy} onClick={() => save('')}>Use studio map instead</button>}
    </div>
  );
}

function VenueSearch({ token, near, onGo }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);

  async function go(e) {
    e.preventDefault();
    const s = q.trim();
    if (!s) return;
    // direct coordinates: "lat, lng" (e.g. -33.9481, 18.8602)
    const m = s.match(/^(-?\d{1,2}(?:\.\d+)?)[,;\s]+(-?\d{1,3}(?:\.\d+)?)$/);
    if (m) { setResults(null); onGo({ lat: +m[1], lng: +m[2] }); return; }
    if (!token) { alert('Add the Mapbox token first — venue search uses it. (Pasting coordinates like “-33.9481, 18.8602” works without it.)'); return; }
    setBusy(true);
    try {
      // Search Box API — unlike plain geocoding it finds VENUES/POIs ("The Ostrich
      // Farm"), not just towns and streets. Bias results to where the map is looking.
      const prox = near ? `&proximity=${near.lng},${near.lat}` : '';
      const url = `https://api.mapbox.com/search/searchbox/v1/forward?q=${encodeURIComponent(s)}&limit=6&types=poi,address,place,locality,neighborhood${prox}&access_token=${encodeURIComponent(token)}`;
      const r = await fetch(url).then((x) => x.json());
      const feats = (r.features || []).map((f) => ({
        name: [f.properties?.name, f.properties?.full_address].filter(Boolean).join(' — ') || 'Result',
        lat: f.geometry?.coordinates?.[1], lng: f.geometry?.coordinates?.[0],
      })).filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lng));
      setResults(feats.length ? feats : []);
    } catch (err) { alert('Search failed: ' + err.message); }
    setBusy(false);
  }

  return (
    <div style={{ position: 'relative', marginBottom: 10 }}>
      <form onSubmit={go} style={{ display: 'flex', gap: 8 }}>
        <input
          style={{ ...inp, marginBottom: 0, flex: 1 }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="🔍 Find the venue — search an address/place, or paste coordinates like -33.9481, 18.8602"
        />
        <button type="submit" style={{ ...btn, fontWeight: 600 }} disabled={busy}>{busy ? 'Searching…' : 'Go'}</button>
      </form>
      {results && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 10, marginTop: 4, boxShadow: '0 8px 30px rgba(0,0,0,0.18)', overflow: 'hidden' }}>
          {results.length === 0 && <div style={{ padding: '10px 12px', fontSize: 13, color: 'var(--muted)' }}>No results — try adding the town/country, or paste coordinates.</div>}
          {results.map((r, i) => (
            <button key={i} onClick={() => { setResults(null); setQ(r.name); onGo(r); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', fontSize: 13, fontFamily: 'inherit', color: 'var(--text)', background: 'none', border: 'none', borderTop: i ? '1px solid var(--hairline)' : 'none', cursor: 'pointer' }}>
              📍 {r.name}
            </button>
          ))}
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>The preview flies there — frame it how attendees should first see it, then hit “📷 Save this view”.</div>
    </div>
  );
}

function TokenSetter({ onSet }) {
  const [t, setT] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <input style={{ ...inp, marginBottom: 0, width: 240 }} placeholder="pk.…  (Mapbox public token)" value={t} onChange={(e) => setT(e.target.value)} />
      <button style={{ ...btn, padding: '6px 12px', fontSize: 12 }} disabled={busy || !t} onClick={async () => {
        setBusy(true);
        try { await api.mapstudioSetToken(t.trim()); onSet(); } catch (e) { alert(e.message); }
        setBusy(false);
      }}>Save token</button>
      <a href="https://console.mapbox.com" target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--brand)' }}>Get one at console.mapbox.com</a>
    </span>
  );
}

const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: 12 };
const btn = { padding: '8px 13px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', minHeight: 36 };
const sel = { ...btn, fontWeight: 600 };
const inp = { display: 'block', width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 9, border: '1px solid var(--hairline)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13.5, fontFamily: 'inherit', marginBottom: 10 };
const lbl = { display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', margin: '0 0 4px' };
const note = { ...card, marginBottom: 12, fontSize: 13, lineHeight: 1.5 };
const addBtn = { position: 'absolute', top: 10, left: 10, zIndex: 5, padding: '9px 14px', borderRadius: 999, border: 'none', color: '#fff', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit', backdropFilter: 'blur(8px)' };
