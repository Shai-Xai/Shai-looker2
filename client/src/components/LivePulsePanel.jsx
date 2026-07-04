import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useAuth } from '../lib/auth.jsx';

// The "Live updates" tab of the Alerts page (Live Pulse). Where an alert watches ONE
// number for a threshold, a live update sends the team a compact MULTI-metric snapshot
// every N minutes while the event runs — gates in (+delta, ~rate/hr), bar revenue,
// top bars, device health — with an optional "% of last event" comparison. Dual-surface
// like alerts: the same panel serves a client self-serving and an admin scoped to the
// active client; the server guard (alerts.manage) decides who may write.
//
// Mobile-first: single stacked column; the editor is a full-height sheet on phones.
export default function LivePulsePanel({ suites }) {
  const { isAdmin } = useAuth(); // admins (incl. client preview) always get the create/manage controls
  const [bySuite, setBySuite] = useState({}); // suiteId -> { pulses, canManage, smsAvailable, whatsappAvailable, eventopsAvailable }
  const [editor, setEditor] = useState(null); // { suiteId, pulse } | null

  const loadSuite = useCallback((sid) => {
    api.suiteLivePulses(sid).then((r) => setBySuite((m) => ({ ...m, [sid]: r }))).catch(() => {});
  }, []);
  useEffect(() => { suites.forEach((s) => loadSuite(s.id)); }, [suites.map((s) => s.id).join(','), loadSuite]); // eslint-disable-line react-hooks/exhaustive-deps
  const reloadAll = () => suites.forEach((s) => loadSuite(s.id));

  // A real admin can always manage (the server's canManage() bypasses the client
  // permission for admins), so the save will succeed — show the button even when the
  // client-scoped permission would hide it (e.g. admin viewing a client in preview).
  const rows = suites.map((s) => ({ suite: s, pulses: [], loaded: bySuite[s.id] !== undefined, ...(bySuite[s.id] || {}), canManage: !!(bySuite[s.id]?.canManage) || isAdmin }));

  const toggleLive = (p) => api.setLivePulseLive(p.id, !p.live).then(() => loadSuite(p.suiteId)).catch((e) => window.alert(e.message));
  const toggleStatus = (p) => api.setLivePulseStatus(p.id, p.status === 'paused' ? 'active' : 'paused').then(() => loadSuite(p.suiteId)).catch((e) => window.alert(e.message));
  // Duplicate = open the editor prefilled from the source with no id (same pattern as
  // DigestManager). Go-live state + time window are deliberately NOT copied, so a copy
  // can never start sending the moment it's created.
  const duplicate = (p) => setEditor({ suiteId: p.suiteId, pulse: { ...p, id: '', name: `${p.name} (copy)`, live: false, windowStart: '', windowEnd: '' } });

  if (!rows.length) return <div style={empty}>No events yet. Once you have an event, set up its live updates here.</div>;

  return (
    <>
      <p style={{ color: 'var(--muted)', fontSize: 13, margin: '0 0 16px', lineHeight: 1.5 }}>
        A mini report on your phone every half hour while the event runs — people through the gates (and the pace),
        bar revenue, your top bars, device health. Press <b>Go live</b> when doors open, or set a time window.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
        {rows.map(({ suite, pulses = [], canManage, loaded }) => (
          <section key={suite.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <h2 style={eventName}>{suite.name}</h2>
              <span style={{ flex: 1 }} />
              {loaded && canManage && (
                <button onClick={() => setEditor({ suiteId: suite.id, pulse: null })} style={addBtn}>＋ {pulses.length ? 'Add' : 'New live update'}</button>
              )}
            </div>
            {!loaded && <div className="skel" style={{ width: '100%', height: 68, borderRadius: 12 }} />}
            {loaded && (pulses.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {pulses.map((p) => (
                  <PulseRow key={p.id} pulse={p} canManage={canManage}
                    onEdit={() => setEditor({ suiteId: suite.id, pulse: p })}
                    onDuplicate={() => duplicate(p)}
                    onToggleLive={() => toggleLive(p)} onToggleStatus={() => toggleStatus(p)} />
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>No live updates yet — set one up before event day.</div>
            ))}
          </section>
        ))}
      </div>
      {editor && (
        <LivePulseEditor
          suiteId={editor.suiteId}
          suiteName={suites.find((s) => s.id === editor.suiteId)?.name}
          entityId={suites.find((s) => s.id === editor.suiteId)?.entityId}
          otherSuites={suites.filter((s) => s.id !== editor.suiteId && s.entityId === suites.find((x) => x.id === editor.suiteId)?.entityId)}
          pulse={editor.pulse}
          caps={bySuite[editor.suiteId] || {}}
          onClose={() => setEditor(null)}
          onSaved={reloadAll}
        />
      )}
    </>
  );
}

// One live update as a row: name, live/paused chip, the setup in a sentence, and the
// Go live / Stop switch (the organiser's manual override on the night).
function PulseRow({ pulse: p, canManage, onEdit, onDuplicate, onToggleLive, onToggleStatus }) {
  const chip = p.status === 'paused' ? { label: 'Paused', bg: 'rgba(128,128,128,0.15)', fg: 'var(--muted)' }
    : p.liveNow ? { label: '● Live', bg: 'rgba(220,38,38,0.12)', fg: 'var(--error, #dc2626)' }
      : (p.windowStart ? { label: 'Scheduled', bg: 'rgba(10,132,255,0.12)', fg: 'var(--brand)' } : { label: 'Idle', bg: 'rgba(128,128,128,0.12)', fg: 'var(--muted)' });
  const chIcon = { push: '📱', email: '✉️', sms: '💬', whatsapp: '🟢' };
  const blockNames = (p.blocks || []).map((b) => b.label || b.tileName || b.measureLabel || (b.type === 'eventops' ? 'Devices' : 'Metric'));
  return (
    <div style={card}>
      <div role="button" tabIndex={0} onClick={canManage ? onEdit : undefined} onKeyDown={(e) => { if (canManage && (e.key === 'Enter' || e.key === ' ')) onEdit(); }} style={{ flex: 1, minWidth: 0, cursor: canManage ? 'pointer' : 'default' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 14.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>⚡ {p.name}</span>
          <span style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 980, background: chip.bg, color: chip.fg, flexShrink: 0 }}>{chip.label}</span>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.4 }}>
          Every {p.cadenceMin} min · {blockNames.slice(0, 4).join(' · ')}{blockNames.length > 4 ? ` +${blockNames.length - 4}` : ''}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, fontSize: 11.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
          <span>🗂 inbox{(p.channels || []).map((c) => ` · ${chIcon[c] || ''} ${c === 'push' ? 'app' : c}`).join('')}</span>
          {p.sendCount > 0 && <span>· sent {p.sendCount}×{p.lastSentAt ? ` · last ${rel(p.lastSentAt)}` : ''}</span>}
        </div>
      </div>
      {canManage && p.status !== 'paused' && (
        <button onClick={onToggleLive} style={{ ...liveBtn, ...(p.live ? liveBtnOn : {}) }} title={p.live ? 'Stop the live updates' : 'Start sending now (doors open)'}>
          {p.live ? '■ Stop' : '● Go live'}
        </button>
      )}
      {canManage && (
        <button onClick={onToggleStatus} style={iconBtn} title={p.status === 'paused' ? 'Resume' : 'Pause'} aria-label={p.status === 'paused' ? 'Resume' : 'Pause'}>
          {p.status === 'paused' ? '▶' : '⏸'}
        </button>
      )}
      {canManage && (
        <button onClick={onDuplicate} style={iconBtn} title="Duplicate this live update" aria-label="Duplicate">⧉</button>
      )}
    </div>
  );
}

// ── the editor sheet ────────────────────────────────────────────────────────────
const CADENCES = [15, 30, 45, 60, 90, 120];
const nid = () => Math.random().toString(36).slice(2, 10);

function LivePulseEditor({ suiteId, suiteName, entityId, otherSuites, pulse, caps, onClose, onSaved }) {
  const isMobile = useIsMobile();
  const editing = !!(pulse && pulse.id); // a pulse WITHOUT an id = duplicating (prefilled create)
  const duplicating = !!(pulse && !pulse.id);
  const [targetSuiteId, setTargetSuiteId] = useState(suiteId); // duplicating can retarget another event
  const [name, setName] = useState(pulse?.name || 'Event live update');
  const [cadenceMin, setCadenceMin] = useState(pulse?.cadenceMin || 30);
  const [windowStart, setWindowStart] = useState(toLocalInput(pulse?.windowStart));
  const [windowEnd, setWindowEnd] = useState(toLocalInput(pulse?.windowEnd));
  const [blocks, setBlocks] = useState(pulse?.blocks?.length ? pulse.blocks : [
    // A sensible starting shape — tweak, don't build from scratch.
    { id: nid(), type: 'value', source: 'tile', label: 'Through the gates', icon: '🎟️', unit: '', showDelta: true, showRate: true, compare: false },
    { id: nid(), type: 'value', source: 'tile', label: 'Bar revenue', icon: '💰', unit: 'ZAR', showDelta: true, showRate: false, compare: false },
  ]);
  const [channels, setChannels] = useState(pulse?.channels || ['push']);
  const [smsRecipients, setSmsRecipients] = useState((pulse?.smsRecipients || []).join('\n'));
  const [waRecipients, setWaRecipients] = useState((pulse?.waRecipients || []).join('\n'));
  const [compareSuiteId, setCompareSuiteId] = useState(pulse?.compareSuiteId || '');
  const [compareLabel, setCompareLabel] = useState(pulse?.compareLabel || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [preview, setPreview] = useState(null);      // { message, blocks } — live "what it's pulling now"
  const [previewSent, setPreviewSent] = useState(null); // channels the send-to-me landed on

  // Tile + metric catalogues (shared with the alert editor's endpoints).
  const [cat, setCat] = useState(null);
  const [exCat, setExCat] = useState(null);
  useEffect(() => { if (entityId) api.getMyDigestTiles(entityId).then(setCat).catch(() => setCat({ dashboards: [] })); }, [entityId]);
  useEffect(() => { if (suiteId) api.alertMetricCatalog(suiteId).then(setExCat).catch(() => setExCat({ explores: [] })); }, [suiteId]);
  const dashboards = cat?.dashboards || [];
  const explores = exCat?.explores || [];

  const toggleChannel = (c) => setChannels((x) => (x.includes(c) ? x.filter((y) => y !== c) : [...x, c]));
  const patchBlock = (id, patch) => setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const removeBlock = (id) => setBlocks((bs) => bs.filter((b) => b.id !== id));
  const moveBlock = (id, dir) => setBlocks((bs) => {
    const i = bs.findIndex((b) => b.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= bs.length) return bs;
    const out = [...bs]; [out[i], out[j]] = [out[j], out[i]];
    return out;
  });
  const addBlock = (type) => setBlocks((bs) => [...bs, type === 'eventops'
    ? { id: nid(), type, label: 'Devices', icon: '🎛' }
    : type === 'top_list'
      ? { id: nid(), type, label: 'Top bars', icon: '🏆', topN: 3, unit: 'ZAR' }
      : { id: nid(), type: 'value', source: 'tile', label: '', icon: '', unit: '', showDelta: true, showRate: false, compare: false }]);

  const anyCompare = blocks.some((b) => b.type === 'value' && b.compare);
  const phones = (s) => s.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
  const body = () => ({
    name, cadenceMin: Number(cadenceMin), blocks,
    windowStart: windowStart ? new Date(windowStart).toISOString() : '',
    windowEnd: windowEnd ? new Date(windowEnd).toISOString() : '',
    channels, smsRecipients: phones(smsRecipients), waRecipients: phones(waRecipients),
    compareSuiteId: anyCompare ? compareSuiteId : '', compareLabel,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Johannesburg',
  });

  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (editing) await api.updateLivePulse(pulse.id, body());
      else await api.createLivePulse(duplicating ? targetSuiteId : suiteId, body());
      onSaved?.(); onClose();
    } catch (e) { setErr(e.message || 'Could not save.'); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!window.confirm(`Delete “${name}”?`)) return;
    try { await api.deleteLivePulse(pulse.id); onSaved?.(); onClose(); } catch (e) { setErr(e.message || 'Could not delete.'); }
  };
  const sendNow = async () => {
    setBusy(true); setErr(''); setTestResult(null);
    try { const r = await api.testLivePulse(pulse.id); setTestResult(r); }
    catch (e) { setErr(e.message || 'Send failed.'); } finally { setBusy(false); }
  };
  // The event this preview reads from (a duplicate can be retargeted before save).
  const activeSuiteId = duplicating ? targetSuiteId : suiteId;
  const runPreview = async () => {
    setBusy(true); setErr(''); setPreviewSent(null);
    try { setPreview(await api.previewLivePulse(activeSuiteId, body())); }
    catch (e) { setErr(e.message || 'Couldn’t read the numbers.'); } finally { setBusy(false); }
  };
  const sendToMe = async () => {
    setBusy(true); setErr('');
    try { const r = await api.sendLivePulsePreview(activeSuiteId, body()); setPreview({ message: r.message, blocks: r.blocks }); setPreviewSent(r.delivered || []); }
    catch (e) { setErr(e.message || 'Couldn’t send the preview.'); } finally { setBusy(false); }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={{ ...sheet, maxWidth: isMobile ? '100%' : 520 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span style={{ fontSize: 20 }}>⚡</span>
          <h2 style={{ fontSize: 17, fontWeight: 800, flex: 1 }}>{editing ? 'Edit live update' : duplicating ? 'Duplicate live update' : 'New live update'}{suiteName ? <span style={{ fontWeight: 600, color: 'var(--muted)', fontSize: 13 }}> · {suiteName}</span> : null}</h2>
          <button onClick={onClose} style={xBtn} aria-label="Close">✕</button>
        </div>

        {duplicating && otherSuites.length > 0 && (
          <Field label="Copy into which event?" hint="Everything below is copied from the original. The time window and Go-live switch aren’t — set those on the copy when you’re ready.">
            <select style={inp} value={targetSuiteId} onChange={(e) => setTargetSuiteId(e.target.value)}>
              <option value={suiteId}>{suiteName || 'This event'}</option>
              {otherSuites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
        )}
        {duplicating && !otherSuites.length && (
          <div style={{ ...hintTxt, marginTop: 0, marginBottom: 12 }}>Everything below is copied from the original. The time window and Go-live switch aren’t — set those on the copy when you’re ready.</div>
        )}

        <Field label="Name">
          <input style={inp} value={name} onChange={(e) => setName(e.target.value)} placeholder="Event live update" />
        </Field>

        <Field label="How often" hint="One compact update on this cadence, only while the event is live.">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {CADENCES.map((c) => (
              <button key={c} type="button" onClick={() => setCadenceMin(c)} style={segBtn(Number(cadenceMin) === c)}>{c < 60 ? `${c} min` : `${c / 60}h${c % 60 ? c % 60 : ''}`}</button>
            ))}
          </div>
        </Field>

        <Field label="When it runs" hint="Leave blank and use the Go live button on the night, or set a window so it starts and stops itself.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={winLabel}>From <input type="datetime-local" style={{ ...inp, marginTop: 3 }} value={windowStart} onChange={(e) => setWindowStart(e.target.value)} /></label>
            <label style={winLabel}>Until <input type="datetime-local" style={{ ...inp, marginTop: 3 }} value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} /></label>
          </div>
        </Field>

        <Field label="What each update covers" hint="Numbers show a +change since the last update; tick “pace” for a per-hour rate (e.g. scans/hr).">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {blocks.map((b, i) => (
              <BlockCard key={b.id} block={b} idx={i} count={blocks.length}
                dashboards={dashboards} explores={explores} eventopsAvailable={!!caps.eventopsAvailable}
                onPatch={(patch) => patchBlock(b.id, patch)} onRemove={() => removeBlock(b.id)} onMove={(dir) => moveBlock(b.id, dir)} />
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            <button type="button" onClick={() => addBlock('value')} style={addChip}>＋ Number</button>
            <button type="button" onClick={() => addBlock('top_list')} style={addChip}>＋ Top 3 list</button>
            {caps.eventopsAvailable && !blocks.some((b) => b.type === 'eventops') && (
              <button type="button" onClick={() => addBlock('eventops')} style={addChip}>＋ Device health</button>
            )}
          </div>
        </Field>

        {anyCompare && (
          <Field label="Compare against" hint="Blocks with “vs last event” show how you’re tracking against this event — like-for-like (same day of event, same clock time) or against its final number, per block.">
            <select style={inp} value={compareSuiteId} onChange={(e) => setCompareSuiteId(e.target.value)}>
              <option value="">Pick a past event…</option>
              {otherSuites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <input style={{ ...inp, marginTop: 6 }} value={compareLabel} onChange={(e) => setCompareLabel(e.target.value)} placeholder="Call it… e.g. last year" />
          </Field>
        )}

        <Field label="Where it lands" hint="The inbox always keeps the full night’s log.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Check checked={channels.includes('push')} onChange={() => toggleChannel('push')} label="📱 App notification" />
            <Check checked={channels.includes('email')} onChange={() => toggleChannel('email')} label="✉️ Email (to the team, per their preferences)" />
            <Check checked={channels.includes('sms')} onChange={() => toggleChannel('sms')} label={`💬 SMS${caps.smsAvailable ? '' : ' (not configured yet)'}`} disabled={!caps.smsAvailable} />
            {channels.includes('sms') && (
              <textarea style={{ ...inp, minHeight: 54 }} value={smsRecipients} onChange={(e) => setSmsRecipients(e.target.value)} placeholder={'Phone numbers, one per line\n+27821234567'} />
            )}
            <Check checked={channels.includes('whatsapp')} onChange={() => toggleChannel('whatsapp')} label={`🟢 WhatsApp${caps.whatsappAvailable ? '' : ' (not configured yet)'}`} disabled={!caps.whatsappAvailable} />
            {channels.includes('whatsapp') && (<>
              <textarea style={{ ...inp, minHeight: 54 }} value={waRecipients} onChange={(e) => setWaRecipients(e.target.value)} placeholder={'WhatsApp numbers, one per line\n+27821234567'} />
              <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 }}>
                WhatsApp only reaches numbers that have messaged the Owl in the last 24 hours (WhatsApp’s service-window rule).
                Ask recipients to send the Owl a quick “hi” on event day; anyone outside the window is skipped, the other channels still deliver.
              </div>
            </>)}
          </div>
        </Field>

        {/* Live preview: verify each block is pulling the right number BEFORE going
            live, and optionally push the whole message to your own phone. */}
        <div style={{ display: 'flex', gap: 8, marginBottom: preview ? 8 : 4 }}>
          <button onClick={runPreview} disabled={busy} style={btnGhost}>{busy && !previewSent ? 'Reading…' : '🔍 Preview numbers'}</button>
          <button onClick={sendToMe} disabled={busy} style={btnGhost} title="Send this preview to you only (not the recipient list)">📲 Send to me</button>
        </div>
        {preview && (
          <div style={previewBox}>
            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--muted)', marginBottom: 6 }}>LIVE PREVIEW — WHAT IT’S PULLING RIGHT NOW</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {(preview.blocks || []).map((b) => (
                <div key={b.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12.5 }}>
                  <span style={{ flex: 1, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.icon} {b.label}</span>
                  <span style={{ fontWeight: 700, textAlign: 'right', color: b.ok ? 'var(--text)' : 'var(--error, #dc2626)' }}>
                    {b.type === 'eventops'
                      ? (b.ok ? `${b.ops.deployed}/${b.ops.total} devices` : 'no data')
                      : b.type === 'top_list'
                        ? (b.ok ? b.rows.map((r) => `${r.name} ${r.value}`).join(' · ') : 'no rows')
                        : (b.value != null ? b.value : 'no data')}
                    {b.compare ? <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · vs {b.compare}</span> : null}
                  </span>
                </div>
              ))}
              {!(preview.blocks || []).length && <div style={{ fontSize: 12, color: 'var(--muted)' }}>No configured blocks yet — pick a tile or metric for a block above, then preview.</div>}
            </div>
            {previewSent && (
              <div style={{ fontSize: 11.5, color: previewSent.length ? 'var(--brand)' : 'var(--muted)', fontWeight: 700, marginTop: 8 }}>
                {previewSent.length ? `📲 Sent to you — ${previewSent.join(' + ')}` : 'Nothing to send to — turn on app notifications, or check your account email is set.'}
              </div>
            )}
            {preview.message && (
              <details style={{ marginTop: 8 }}>
                <summary style={{ fontSize: 11, color: 'var(--muted)', cursor: 'pointer' }}>See the full message that would send</summary>
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, lineHeight: 1.5, marginTop: 6 }}>{preview.message}</div>
              </details>
            )}
          </div>
        )}
        {testResult && (
          <div style={previewBox}>
            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--muted)', marginBottom: 5 }}>SENT — THIS IS WHAT LANDED</div>
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, lineHeight: 1.5 }}>{testResult.message}</div>
          </div>
        )}
        {err && <div style={{ color: 'var(--error, #dc2626)', fontSize: 12.5, marginBottom: 10 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          {editing && <button onClick={del} style={btnDelGhost} title="Delete" aria-label="Delete">🗑</button>}
          {editing && <button onClick={sendNow} disabled={busy} style={btnGhost}>Send now</button>}
          <button onClick={save} disabled={busy} style={btnPrimary}>{busy ? 'Saving…' : editing ? 'Save' : duplicating ? 'Create copy' : 'Create live update'}</button>
        </div>
      </div>
    </div>
  );
}

// One block of the update. Type decides the picker: a KPI tile / built metric for a
// number, any table-style tile for a top-3 list, nothing for device health.
function BlockCard({ block: b, idx, count, dashboards, explores, onPatch, onRemove, onMove }) {
  const isKpi = (t) => { const v = t.visType || ''; return v === 'single_value' || v === 'single_value_period_over_period' || v.includes('bar_gauge'); };
  const tilesFor = (dId, kpiOnly) => (dashboards.find((d) => d.dashboardId === dId)?.tiles || []).filter((t) => (kpiOnly ? isKpi(t) : !isKpi(t)));
  const curExplore = explores.find((x) => x.model === b.model && x.view === b.view);
  const typeName = b.type === 'top_list' ? 'Top list' : b.type === 'eventops' ? 'Device health' : 'Number';
  return (
    <div style={blockBox}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', border: '1px solid var(--hairline)', borderRadius: 980, padding: '1px 8px' }}>{typeName}</span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => onMove(-1)} disabled={idx === 0} style={tinyBtn} aria-label="Move up">↑</button>
        <button type="button" onClick={() => onMove(1)} disabled={idx === count - 1} style={tinyBtn} aria-label="Move down">↓</button>
        <button type="button" onClick={onRemove} style={{ ...tinyBtn, color: 'var(--error, #dc2626)' }} aria-label="Remove">✕</button>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: b.type === 'eventops' ? 0 : 8 }}>
        <input style={{ ...inp, width: 64, flexShrink: 0, textAlign: 'center' }} value={b.icon || ''} onChange={(e) => onPatch({ icon: e.target.value })} placeholder="🎟️" aria-label="Emoji" />
        <input style={inp} value={b.label || ''} onChange={(e) => onPatch({ label: e.target.value })} placeholder={b.type === 'top_list' ? 'Top bars' : b.type === 'eventops' ? 'Devices' : 'Through the gates'} aria-label="Label" />
      </div>
      {b.type === 'eventops' && <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Deployed devices, open issues and lost/damaged counts from Event Ops.</div>}

      {b.type === 'value' && (<>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <button type="button" onClick={() => onPatch({ source: 'tile' })} style={segBtn(b.source !== 'metric')}>A dashboard tile</button>
          <button type="button" onClick={() => onPatch({ source: 'metric' })} style={segBtn(b.source === 'metric')}>Build a metric</button>
        </div>
        {b.source !== 'metric' && (<>
          <select style={{ ...inp, marginBottom: 6 }} value={b.dashboardId || ''} onChange={(e) => onPatch({ dashboardId: e.target.value, tileId: '' })}>
            <option value="">Dashboard…</option>
            {dashboards.map((d) => <option key={d.dashboardId} value={d.dashboardId}>{d.title}{d.setName ? ` · ${d.setName}` : ''}</option>)}
          </select>
          {b.dashboardId && (
            <select style={inp} value={b.tileId || ''} onChange={(e) => { const t = tilesFor(b.dashboardId, true).find((x) => x.tileId === e.target.value); onPatch({ tileId: e.target.value, tileName: t?.title || '' }); }}>
              <option value="">KPI tile…</option>
              {tilesFor(b.dashboardId, true).map((t) => <option key={t.tileId} value={t.tileId}>{t.title}</option>)}
            </select>
          )}
        </>)}
        {b.source === 'metric' && (<>
          <select style={{ ...inp, marginBottom: 6 }} value={curExplore ? `${b.model}::${b.view}` : ''} onChange={(e) => { const [model, view] = e.target.value.split('::'); onPatch({ model, view, measure: '' }); }}>
            <option value="">Data source…</option>
            {explores.map((x) => <option key={`${x.model}::${x.view}`} value={`${x.model}::${x.view}`}>{x.label}</option>)}
          </select>
          {curExplore && (
            <select style={inp} value={b.measure || ''} onChange={(e) => { const m = curExplore.measures.find((x) => x.name === e.target.value); onPatch({ measure: e.target.value, measureLabel: m?.label || '' }); }}>
              <option value="">Measure…</option>
              {curExplore.measures.map((m) => <option key={m.name} value={m.name}>{m.label}</option>)}
            </select>
          )}
        </>)}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8, alignItems: 'center' }}>
          <select style={{ ...inp, width: 'auto' }} value={b.unit || ''} onChange={(e) => onPatch({ unit: e.target.value })} aria-label="Unit">
            <option value="">plain number</option>
            <option value="ZAR">money</option>
            <option value="%">%</option>
          </select>
          <Check small checked={b.showDelta !== false} onChange={() => onPatch({ showDelta: !(b.showDelta !== false) })} label="+ change" />
          <Check small checked={!!b.showRate} onChange={() => onPatch({ showRate: !b.showRate })} label="pace /hr" />
          <Check small checked={!!b.compare} onChange={() => onPatch(b.compare ? { compare: false } : { compare: true, compareMode: b.compareMode || 'same_point' })} label="vs last event" />
        </div>
        {b.compare && b.source === 'metric' && (() => {
          const dateDims = (curExplore?.dimensions || []).filter((d) => /date|time|day|hour/i.test(`${d.name} ${d.label || ''}`) || /date|time/i.test(d.type || ''));
          const samePoint = (b.compareMode || 'final') === 'same_point';
          return (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <button type="button" onClick={() => onPatch({ compareMode: 'same_point' })} style={segBtn(samePoint)}>Same point in time</button>
                <button type="button" onClick={() => onPatch({ compareMode: 'final' })} style={segBtn(!samePoint)}>Their final number</button>
              </div>
              {samePoint && (dateDims.length ? (
                <select style={inp} value={b.compareClipField || ''} onChange={(e) => onPatch({ compareClipField: e.target.value })}>
                  <option value="">Date field to cut by…</option>
                  {dateDims.map((d) => <option key={d.name} value={d.name}>{d.label}</option>)}
                </select>
              ) : (
                <div style={hintTxt}>Pick a data source above first — the same-point cut needs a date field.</div>
              ))}
              <div style={hintTxt}>
                Same point in time = the past event cut to the <b>same day of the event at the same clock time</b> —
                a fair, like-for-like read whether the event is one day or five. If the cut can’t be made it
                falls back to their final number (and says so).
              </div>
            </div>
          );
        })()}
        {b.compare && b.source !== 'metric' && (
          <div style={hintTxt}>Tile blocks compare against the past event’s <b>final</b> number. For a like-for-like “same point in time” comparison, switch this block to “Build a metric”.</div>
        )}
      </>)}

      {b.type === 'top_list' && (<>
        <select style={{ ...inp, marginBottom: 6 }} value={b.dashboardId || ''} onChange={(e) => onPatch({ dashboardId: e.target.value, tileId: '' })}>
          <option value="">Dashboard…</option>
          {dashboards.map((d) => <option key={d.dashboardId} value={d.dashboardId}>{d.title}{d.setName ? ` · ${d.setName}` : ''}</option>)}
        </select>
        {b.dashboardId && (
          <select style={inp} value={b.tileId || ''} onChange={(e) => { const t = tilesFor(b.dashboardId, false).find((x) => x.tileId === e.target.value); onPatch({ tileId: e.target.value, tileName: t?.title || '' }); }}>
            <option value="">Breakdown tile (e.g. revenue by bar)…</option>
            {tilesFor(b.dashboardId, false).map((t) => <option key={t.tileId} value={t.tileId}>{t.title}</option>)}
          </select>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12, color: 'var(--muted)' }}>Show top{' '}
            <select style={{ ...inp, width: 'auto', display: 'inline-block' }} value={b.topN || 3} onChange={(e) => onPatch({ topN: Number(e.target.value) })}>
              {[3, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <select style={{ ...inp, width: 'auto' }} value={b.unit || ''} onChange={(e) => onPatch({ unit: e.target.value })} aria-label="Unit">
            <option value="">plain number</option>
            <option value="ZAR">money</option>
            <option value="%">%</option>
          </select>
        </div>
      </>)}
    </div>
  );
}

function Field({ label, hint, children, style }) {
  return (
    <div style={{ marginBottom: 14, ...style }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 5 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>{hint}</div>}
    </div>
  );
}
function Check({ checked, onChange, label, disabled, small }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: small ? 12 : 13.5, color: disabled ? 'var(--muted)' : 'var(--text)', cursor: disabled ? 'default' : 'pointer', minHeight: small ? undefined : 24 }}>
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} style={{ width: small ? 15 : 17, height: small ? 15 : 17, accentColor: 'var(--brand)' }} />
      {label}
    </label>
  );
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function rel(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const eventName = { fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' };
const addBtn = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--brand)', borderRadius: 9, fontSize: 12.5, fontWeight: 700, padding: '6px 11px', cursor: 'pointer', flexShrink: 0 };
const card = { display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', padding: '12px 14px' };
const iconBtn = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 9, width: 38, height: 34, fontSize: 13, cursor: 'pointer', flexShrink: 0 };
const liveBtn = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--error, #dc2626)', borderRadius: 9, height: 34, fontSize: 12, fontWeight: 800, padding: '0 10px', cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap' };
const liveBtnOn = { background: 'var(--error, #dc2626)', color: '#fff', border: 'none' };
const empty = { padding: '28px 18px', textAlign: 'center', color: 'var(--muted)', border: '1px dashed var(--hairline)', borderRadius: 14 };
const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 100 };
const sheet = { width: '100%', maxHeight: '90vh', overflowY: 'auto', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, padding: '18px 18px 20px', boxShadow: 'var(--shadow-lg, 0 12px 40px rgba(0,0,0,0.28))', color: 'var(--text)' };
const inp = { width: '100%', boxSizing: 'border-box', padding: '9px 11px', border: '1.5px solid var(--hairline)', borderRadius: 9, fontSize: 14, outline: 'none', background: 'var(--card)', color: 'var(--text)', fontFamily: 'inherit' };
const xBtn = { border: 'none', background: 'rgba(128,128,128,0.12)', color: 'var(--muted-2)', borderRadius: 980, width: 28, height: 28, fontSize: 13, cursor: 'pointer' };
const segBtn = (active) => ({ border: active ? '1.5px solid var(--brand)' : '1.5px solid var(--hairline)', background: active ? 'rgba(var(--brand-rgb,10,132,255),0.08)' : 'var(--card)', color: active ? 'var(--brand)' : 'var(--text)', borderRadius: 9, fontSize: 12.5, fontWeight: 700, padding: '7px 11px', cursor: 'pointer' });
const blockBox = { border: '1px solid var(--hairline)', borderRadius: 12, padding: '10px 12px', background: 'rgba(128,128,128,0.04)' };
const tinyBtn = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--muted)', borderRadius: 7, width: 26, height: 24, fontSize: 11, cursor: 'pointer', lineHeight: 1 };
const addChip = { border: '1px dashed var(--hairline)', background: 'transparent', color: 'var(--brand)', borderRadius: 9, fontSize: 12, fontWeight: 700, padding: '7px 11px', cursor: 'pointer' };
const winLabel = { fontSize: 12, fontWeight: 600, color: 'var(--muted)' };
const hintTxt = { fontSize: 11, color: 'var(--muted)', marginTop: 6, lineHeight: 1.4 };
const previewBox = { marginBottom: 10, padding: '10px 12px', background: 'rgba(var(--brand-rgb,10,132,255),0.07)', border: '1px solid var(--hairline)', borderRadius: 10 };
const btnGhost = { flex: '0 0 auto', padding: '10px 14px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' };
const btnDelGhost = { flex: '0 0 auto', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--error, #dc2626)', fontSize: 15, cursor: 'pointer' };
const btnPrimary = { flex: 1, padding: '10px 16px', borderRadius: 10, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13.5, fontWeight: 800, cursor: 'pointer' };
