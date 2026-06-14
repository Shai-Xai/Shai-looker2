import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { AudienceFilters } from './CampaignManager.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';

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

  const load = () => api.listSegments(entityId).then((r) => setSegments(r.segments || [])).catch(() => setSegments([]));
  useEffect(() => { load(); }, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { (isAdmin ? api.getDigestTiles(entityId) : api.getMyDigestTiles(entityId)).then(setTiles).catch(() => setTiles({ dashboards: [] })); }, [entityId, isAdmin]);

  // Resolve the source labels (event / dashboard / tile) from the tiles catalog.
  const sourceLabel = (s) => {
    const d = s.definition || {};
    if (d.mode === 'paste') return { event: '', detail: 'Pasted list' };
    const dash = tiles?.dashboards?.find((x) => x.dashboardId === d.dashboardId);
    const tile = dash?.tiles?.find((t) => t.tileId === d.tileId);
    return { event: dash?.suiteName || '', detail: tile?.title || dash?.title || '' };
  };

  if (!segments) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>;

  if (editing) {
    return <SegmentBuilder entityId={entityId} tiles={tiles} segment={editing === 'new' ? null : editing}
      onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />;
  }

  const refresh = (s) => { setBusyId(s.id); api.previewSegment(entityId, s.id).then(load).catch(() => {}).finally(() => setBusyId(null)); };
  const del = (s) => { if (confirm(`Delete segment “${s.name}”?`)) api.deleteSegment(entityId, s.id).then(load); };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>Reusable, always-live audiences — built from a dashboard tile (with filters) or a pasted list. Use them in campaigns; counts update each time.</p>
        <button style={primary} onClick={() => setEditing('new')}>+ New segment</button>
      </div>

      {segments.length === 0 ? (
        <p style={{ color: 'var(--muted)', fontSize: 13, padding: '20px 0' }}>No segments yet. Create one from a dashboard tile or a pasted list.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {segments.map((s) => {
            const lbl = sourceLabel(s);
            return (
              <div key={s.id} style={{ border: '1px solid var(--hairline)', borderRadius: 14, padding: isMobile ? '16px' : '14px 16px', display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'stretch' : 'center', gap: isMobile ? 12 : 14, background: 'var(--card)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: isMobile ? 17 : 15 }}>{s.name}</span>
                    <span style={{ fontSize: 10.5, fontWeight: 700, borderRadius: 980, padding: '2px 9px', background: 'rgba(128,128,128,0.14)', color: 'var(--muted)' }}>{s.source === 'paste' ? 'Pasted list' : 'Dashboard tile'}</span>
                  </div>
                  {lbl.event && <div style={{ fontSize: 12.5, color: 'var(--text)', marginTop: 5, fontWeight: 600 }}>🗓 {lbl.event}</div>}
                  {lbl.detail && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lbl.detail}</div>}
                  <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>
                    {s.count >= 0
                      ? <span><b style={{ color: 'var(--brand)' }}>{s.count}</b> {s.count === 1 ? 'person' : 'people'}{s.lastResolvedAt ? ` · as of ${new Date(s.lastResolvedAt).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</span>
                      : <span>Not counted yet — tap refresh</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button style={{ ...mini, flex: isMobile ? 1 : undefined, padding: isMobile ? '10px 12px' : mini.padding }} onClick={() => refresh(s)} disabled={busyId === s.id}>{busyId === s.id ? '…' : '↻ Refresh'}</button>
                  <button style={{ ...mini, flex: isMobile ? 1 : undefined, padding: isMobile ? '10px 12px' : mini.padding }} onClick={() => setEditing(s)}>Edit</button>
                  <button style={{ ...mini, flex: isMobile ? 1 : undefined, padding: isMobile ? '10px 12px' : mini.padding, color: 'var(--error,#ef4444)' }} onClick={() => del(s)}>Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SegmentBuilder({ entityId, tiles, segment, onClose, onSaved }) {
  const def = segment?.definition || {};
  const [name, setName] = useState(segment?.name || '');
  const [f, setF] = useState({
    mode: def.mode || 'tile',
    dashboardId: def.dashboardId || '', tileId: def.tileId || '',
    emailField: def.emailField || '', nameField: def.nameField || '', phoneField: def.phoneField || '',
    attrDashboardId: def.attrDashboardId || '', attrTileId: def.attrTileId || '',
    filters: def.filters || [], pasted: def.pasted || '',
  });
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const [aud, setAud] = useState(null);
  const [busy, setBusy] = useState(false);
  const debounce = useRef();

  const definition = () => ({
    mode: f.mode, dashboardId: f.dashboardId, tileId: f.tileId,
    emailField: f.emailField, nameField: f.nameField, phoneField: f.phoneField,
    attrDashboardId: f.attrDashboardId, attrTileId: f.attrTileId, filters: f.filters, pasted: f.pasted,
  });

  const refreshAud = () => {
    if (f.mode === 'tile' && (!f.dashboardId || !f.tileId)) { setAud(null); return; }
    api.actionAudiencePreview(entityId, { audience: definition() }).then(setAud).catch((e) => setAud({ error: e.message }));
  };
  useEffect(() => { clearTimeout(debounce.current); debounce.current = setTimeout(refreshAud, 350); return () => clearTimeout(debounce.current); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [f.mode, f.dashboardId, f.tileId, f.emailField, f.attrDashboardId, f.attrTileId, JSON.stringify(f.filters), f.pasted]);

  const addFilter = () => set('filters', [...f.filters, { field: '', op: 'in', values: [] }]);
  const setFilter = (i, patch) => set('filters', f.filters.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const removeFilter = (i) => set('filters', f.filters.filter((_, j) => j !== i));

  const save = async () => {
    if (!name.trim()) { alert('Give the segment a name.'); return; }
    setBusy(true);
    try {
      if (segment) await api.updateSegment(entityId, segment.id, { name, definition: definition() });
      else await api.createSegment(entityId, { name, definition: definition() });
      onSaved();
    } catch (e) { alert('Save failed: ' + e.message); }
    finally { setBusy(false); }
  };

  const dash = tiles?.dashboards?.find((d) => d.dashboardId === f.dashboardId);

  return (
    <div>
      <button style={{ ...mini, marginBottom: 12 }} onClick={onClose}>← Back to segments</button>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640 }}>
        <Field label="Segment name">
          <input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. VIP buyers — Bushfire" />
        </Field>

        <Field label="Source">
          <div style={{ display: 'flex', gap: 8 }}>
            <Toggle on={f.mode === 'tile'} onClick={() => set('mode', 'tile')}>From a dashboard tile</Toggle>
            <Toggle on={f.mode === 'paste'} onClick={() => set('mode', 'paste')}>Paste a list</Toggle>
          </div>
        </Field>

        {f.mode === 'tile' ? (
          <Field label="Audience">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <select style={input} value={f.dashboardId} onChange={(e) => { set('dashboardId', e.target.value); set('tileId', ''); set('emailField', ''); }}>
                <option value="">Pick a dashboard…</option>
                {(tiles?.dashboards || []).map((d) => <option key={d.dashboardId} value={d.dashboardId}>{d.title} — {d.setName}</option>)}
              </select>
              {dash && (
                <select style={input} value={f.tileId} onChange={(e) => { set('tileId', e.target.value); set('emailField', ''); }}>
                  <option value="">Pick the tile listing the people…</option>
                  {dash.tiles.map((t) => <option key={t.tileId} value={t.tileId}>{t.title}</option>)}
                </select>
              )}
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
                  <div style={hintS}>A segment is just <i>who matches</i> — consent &amp; unsubscribes are applied per channel when a campaign sends to it.</div>
                  <AudienceFilters entityId={entityId}
                    fields={(aud.filterFields && aud.filterFields.length) ? aud.filterFields : aud.fields.map((fl) => ({ ...fl, dashboardId: f.dashboardId, tileId: f.tileId }))}
                    filters={f.filters} addFilter={addFilter} setFilter={setFilter} removeFilter={removeFilter}
                    attr={{ dashboardId: f.attrDashboardId, tileId: f.attrTileId }}
                    tiles={tiles} onAttr={(dashboardId, tileId) => { set('attrDashboardId', dashboardId); set('attrTileId', tileId); }} />
                </>
              )}
            </div>
          </Field>
        ) : (
          <Field label="Paste emails and/or mobile numbers">
            <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={4} value={f.pasted} onChange={(e) => set('pasted', e.target.value)} placeholder="one@example.com, +27821234567, two@example.com …" onBlur={refreshAud} />
            <div style={hintS}>Numbers become SMS-reachable; emails become email-reachable. Any separator.</div>
          </Field>
        )}

        <div style={{ fontSize: 13 }}>
          {aud?.error ? <span style={{ color: 'var(--error,#ef4444)' }}>✗ {aud.error}</span>
            : aud ? <span><b style={{ color: 'var(--brand)' }}>{aud.count}</b> {aud.count === 1 ? 'person' : 'people'} match right now{aud.filteredOut > 0 ? ` · ${aud.filteredOut} filtered out` : ''}</span>
              : <span style={{ color: 'var(--muted)' }}>Pick a source to see the live count.</span>}
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          <button style={primary} onClick={save} disabled={busy}>{busy ? 'Saving…' : segment ? 'Save changes' : 'Create segment'}</button>
          <button style={mini} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) { return <div><div style={lbl}>{label}</div>{children}</div>; }
function Toggle({ on, onClick, children }) {
  return <button type="button" onClick={onClick} style={{ flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: on ? '1.5px solid var(--brand)' : '1.5px solid var(--hairline)', background: on ? 'rgba(var(--brand-rgb,255,56,92),0.08)' : 'transparent', color: on ? 'var(--brand)' : 'var(--text)' }}>{children}</button>;
}

const input = { width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', background: 'var(--card)', color: 'var(--text)' };
const mini = { padding: '7px 12px', borderRadius: 8, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const primary = { padding: '9px 18px', borderRadius: 980, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const hintS = { fontSize: 11.5, color: 'var(--muted)', marginTop: 4 };
const lbl = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted)', marginBottom: 5 };
