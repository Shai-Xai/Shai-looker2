import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { AudienceFilters } from './CampaignManager.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';

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

  const load = () => api.listSegments(entityId).then((r) => setSegments(r.segments || [])).catch(() => setSegments([]));
  // Materialise a built-in recipe (e.g. abandoned cart) as a real, live segment.
  const addRecipe = async (key) => {
    setAddingKey(key);
    try { await api.createSegmentFromRecipe(entityId, key); await load(); }
    catch (e) { alert(e.message || 'Could not add this segment.'); }
    finally { setAddingKey(''); }
  };
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
  const viewPeople = (s) => { setViewing({ segment: s, data: null }); api.segmentMembers(entityId, s.id).then((d) => setViewing({ segment: s, data: d })).catch((e) => setViewing({ segment: s, data: { error: e.message } })); };

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
                  {s.count >= 0 && s.reach && (s.reach.email >= 0 || s.reach.sms >= 0) && (
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      {s.reach.email >= 0 && <span>✉️ {s.reach.email} with email</span>}
                      {s.reach.sms >= 0 && <span>💬 {s.reach.sms} with mobile</span>}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
                  <button style={{ ...mini, flex: isMobile ? 1 : undefined, padding: isMobile ? '10px 12px' : mini.padding }} onClick={() => viewPeople(s)}>👥 List</button>
                  <button style={{ ...mini, flex: isMobile ? 1 : undefined, padding: isMobile ? '10px 12px' : mini.padding }} onClick={() => refresh(s)} disabled={busyId === s.id}>{busyId === s.id ? '…' : '↻ Refresh'}</button>
                  <button style={{ ...mini, flex: isMobile ? 1 : undefined, padding: isMobile ? '10px 12px' : mini.padding }} onClick={() => setEditing(s)}>Edit</button>
                  <button style={{ ...mini, flex: isMobile ? 1 : undefined, padding: isMobile ? '10px 12px' : mini.padding, color: 'var(--error,#ef4444)' }} onClick={() => del(s)}>Delete</button>
                </div>
              </div>
            );
          })}
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
                  <button style={{ ...primary, padding: '6px 14px', fontSize: 12.5 }} onClick={() => addRecipe(r.key)} disabled={addingKey === r.key}>{addingKey === r.key ? 'Adding…' : '+ Add'}</button>
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
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{viewing.data ? (viewing.data.error ? viewing.data.error : `${viewing.data.count} ${viewing.data.count === 1 ? 'person' : 'people'}${viewing.data.capped ? ' · showing first 2,000' : ''}`) : 'Resolving live…'}</div>
              </div>
              <button style={mini} onClick={() => setViewing(null)}>Close</button>
            </div>
            <div style={{ overflowY: 'auto', padding: '4px 0' }}>
              {!viewing.data ? <p style={{ color: 'var(--muted)', fontSize: 13, padding: 16 }}>Loading…</p>
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
  const def = segment?.definition || {};
  const [name, setName] = useState(segment?.name || '');
  const [f, setF] = useState({
    mode: def.mode || 'tile',
    dashboardId: def.dashboardId || '', tileId: def.tileId || '',
    emailField: def.emailField || '', nameField: def.nameField || '', phoneField: def.phoneField || '',
    emailConsentField: def.emailConsentField || '', smsConsentField: def.smsConsentField || '',
    attrDashboardId: def.attrDashboardId || '', attrTileId: def.attrTileId || '',
    filters: def.filters || [], pasted: def.pasted || '',
    // Dashboard filters captured when the segment was made from a tile. Not
    // edited here, but preserved so saving doesn't silently change the cohort.
    lookerFilters: def.lookerFilters || {},
  });
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const [aud, setAud] = useState(null);
  const [busy, setBusy] = useState(false);
  const debounce = useRef();

  const definition = () => ({
    mode: f.mode, dashboardId: f.dashboardId, tileId: f.tileId,
    emailField: f.emailField, nameField: f.nameField, phoneField: f.phoneField,
    emailConsentField: f.emailConsentField, smsConsentField: f.smsConsentField,
    attrDashboardId: f.attrDashboardId, attrTileId: f.attrTileId, filters: f.filters, pasted: f.pasted,
    lookerFilters: f.lookerFilters,
  });

  const refreshAud = () => {
    if (f.mode === 'tile' && (!f.dashboardId || !f.tileId)) { setAud(null); return; }
    api.actionAudiencePreview(entityId, { audience: definition() }).then(setAud).catch((e) => setAud({ error: e.message }));
  };
  useEffect(() => { clearTimeout(debounce.current); debounce.current = setTimeout(refreshAud, 350); return () => clearTimeout(debounce.current); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [f.mode, f.dashboardId, f.tileId, f.emailField, f.phoneField, f.emailConsentField, f.smsConsentField, f.attrDashboardId, f.attrTileId, JSON.stringify(f.filters), f.pasted]);

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
        ) : (
          <Field label="Paste emails and/or mobile numbers">
            <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={4} value={f.pasted} onChange={(e) => set('pasted', e.target.value)} placeholder="one@example.com, +27821234567, two@example.com …" onBlur={refreshAud} />
            <div style={hintS}>Numbers become SMS-reachable; emails become email-reachable. Any separator.</div>
          </Field>
        )}

        <div style={{ fontSize: 13 }}>
          {aud?.error ? <span style={{ color: 'var(--error,#ef4444)' }}>✗ {aud.error}</span>
            : aud ? <span><b style={{ color: 'var(--brand)' }}>{aud.count}</b> {aud.count === 1 ? 'person' : 'people'} match{aud.reach ? ` · ${aud.reach.email} emailable · ${aud.reach.sms} SMS` : ''}{aud.filteredOut > 0 ? ` · ${aud.filteredOut} filtered out` : ''}</span>
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
