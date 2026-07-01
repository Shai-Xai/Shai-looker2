import { useEffect, useState, lazy, Suspense } from 'react';
import { api } from '../lib/api.js';

// PUBLIC staff scan portal — no Pulse account. The per-event token in the URL gates access;
// staff identify by their staff number, then scan to move devices / log issues (attributed
// to them) and see the stations they're posted to. Self-contained; reuses only the scanner.
const EventOpsScanner = lazy(() => import('../components/EventOpsScanner.jsx'));

const KIND_ICON = { bar: '🍺', gate: '🛂', booth: '🏪', topup: '💳', vendor: '🍔', other: '📍' };
const ISSUE_CATEGORIES = ['damaged', 'battery', 'connectivity', 'missing_parts', 'frozen', 'wrong_config', 'other'];
const RESOLUTIONS = ['Swapped device', 'Rebooted', 'Battery replaced', 'Reconnected', 'Replaced part', 'Reconfigured', 'Cleared error', 'False alarm'];
const CAT_LABEL = { damaged: 'Damaged', battery: 'Battery', connectivity: 'Connectivity', missing_parts: 'Missing parts', frozen: 'Frozen', wrong_config: 'Wrong config', other: 'Other' };

export default function EventOpsPortalPage({ suiteId, token }) {
  const [info, setInfo] = useState(null);     // { suite, stations } | { error }
  const [staff, setStaff] = useState(null);   // logged-in staff
  const [me, setMe] = useState(null);         // their stations + devices + issues
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [scanning, setScanning] = useState(false); // top-level scan — used to log an issue
  const [device, setDevice] = useState(null); // scanned device → issue sheet
  const [moving, setMoving] = useState(false); // station-first move flow open
  const [checking, setChecking] = useState(false); // checkpoint sheet open
  const [toast, setToast] = useState('');
  const storeKey = `eop_portal_${suiteId}`;

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 2200); };

  useEffect(() => {
    api.eopPortalInfo(suiteId, token).then(setInfo).catch(() => setInfo({ error: true }));
  }, [suiteId, token]);

  // Resume a previous login on this device.
  useEffect(() => {
    const id = localStorage.getItem(storeKey);
    if (id) api.eopPortalMe(suiteId, token, id).then((r) => { setStaff(r.staff); setMe(r); }).catch(() => localStorage.removeItem(storeKey));
  }, [suiteId, token]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshMe = (id = staff?.id) => id && api.eopPortalMe(suiteId, token, id).then(setMe).catch(() => {});

  async function login(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await api.eopPortalLogin(suiteId, token, number.trim());
      setStaff(r.staff); localStorage.setItem(storeKey, r.staff.id);
      const m = await api.eopPortalMe(suiteId, token, r.staff.id); setMe(m);
    } catch (e2) { setErr(e2.message || 'Login failed'); }
    setBusy(false);
  }
  function logout() { localStorage.removeItem(storeKey); setStaff(null); setMe(null); setNumber(''); }

  async function onScanned(code) {
    setScanning(false);
    if (!code) return;
    try { const r = await api.eopPortalScan(suiteId, token, code); setDevice(r.device); }
    catch (e2) { flash(e2.message || 'Device not found'); }
  }

  if (!info) return <Center>Loading…</Center>;
  if (info.error) return <Center>This staff link is invalid or has been turned off. Ask your manager for a new one.</Center>;

  return (
    <div style={page}>
      <div style={{ maxWidth: 520, margin: '0 auto', padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div style={kicker}>Event Ops · Staff</div>
            <div style={{ fontSize: 20, fontWeight: 800 }}>{info.suite.name}</div>
          </div>
          {staff && <button onClick={logout} style={ghostBtn}>Sign out</button>}
        </div>

        {!staff ? (
          <form onSubmit={login} style={{ ...card, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontWeight: 700 }}>Enter your staff number</div>
            <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="e.g. 101" autoFocus inputMode="numeric"
              style={{ ...input, fontSize: 20, textAlign: 'center', letterSpacing: 2 }} />
            {err && <div style={{ color: 'var(--error)', fontSize: 13 }}>{err}</div>}
            <button type="submit" disabled={busy || !number.trim()} style={bigBtn}>{busy ? 'Checking…' : 'Start'}</button>
          </form>
        ) : (
          <>
            <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              <span style={badgeBig}>{staff.number || '—'}</span>
              <div>
                <div style={{ fontWeight: 700 }}>{staff.name || 'Staff'}</div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{staff.role || 'On shift'}</div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
              <button onClick={() => setScanning(true)} style={{ ...bigBtn, fontSize: 17, padding: '15px' }}>⚠️ Log an issue</button>
              {staff.canMove !== false && (
                <button onClick={() => setMoving(true)} style={secondaryBtn}>🔀 Move devices</button>
              )}
              {staff.canCheckpoint && (
                <button onClick={() => setChecking(true)} style={secondaryBtn}>✅ Checkpoint</button>
              )}
            </div>

            <div style={kicker}>My stations</div>
            {(!me || me.stations.length === 0) ? (
              <div style={{ ...card, color: 'var(--muted)', fontSize: 13, marginBottom: 18 }}>
                You’re not assigned to a station yet — you can still scan any device to move it or log an issue.
              </div>
            ) : me.stations.map((s) => <StationCard key={s.id} station={s} />)}

            <div style={{ ...kicker, marginTop: 18 }}>Issues</div>
            <PortalIssues suiteId={suiteId} token={token} staffId={staff.id} onChange={() => refreshMe()} flash={flash} />
          </>
        )}
      </div>

      {scanning && (
        <Suspense fallback={null}>
          <EventOpsScanner onCode={onScanned} onClose={() => setScanning(false)} title="Scan the device with the issue" />
        </Suspense>
      )}
      {device && (
        <IssueSheet
          suiteId={suiteId} token={token} staffId={staff.id} device={device}
          onClose={() => setDevice(null)}
          onDone={(msg) => { setDevice(null); if (msg) flash(msg); refreshMe(); }}
        />
      )}
      {moving && (
        <MoveFlow
          suiteId={suiteId} token={token} staffId={staff.id} stations={info.stations}
          onClose={() => setMoving(false)}
          onDone={(msg) => { if (msg) flash(msg); refreshMe(); }}
          flash={flash}
        />
      )}
      {checking && (
        <CheckpointSheet
          suiteId={suiteId} token={token} staffId={staff.id}
          stations={info.stations} checkpoints={info.checkpoints || []}
          myStationIds={(me?.stations || []).map((s) => s.id)}
          onClose={() => setChecking(false)}
          onDone={() => { setChecking(false); flash('Checkpoint submitted'); }}
        />
      )}
      {toast && <div style={toastStyle}>{toast}</div>}
    </div>
  );
}

function StationCard({ station }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ ...card, marginBottom: 10 }}>
      <button onClick={() => setOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text)' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 20 }}>{KIND_ICON[station.kind] || '📍'}</span>
          <span style={{ fontWeight: 700, fontSize: 15 }}>{station.name}</span>
        </span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <span style={{ fontWeight: 800, color: 'var(--brand)' }}>{station.devices.length} dev</span>
          {station.issues.length > 0 && <span style={{ fontWeight: 700, color: 'var(--error)' }}>⚠ {station.issues.length}</span>}
          <span style={{ color: 'var(--muted)' }}>{open ? '▴' : '▾'}</span>
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {station.devices.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No devices here.</div>
            : station.devices.map((d) => <div key={d.id} style={miniRow}><span>{d.label || d.qrCode}</span><span style={{ color: 'var(--muted)', fontSize: 12 }}>{d.type}</span></div>)}
          {station.issues.length > 0 && <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', marginTop: 6 }}>OPEN ISSUES</div>}
          {station.issues.map((i) => (
            <div key={i.id} style={{ ...miniRow, color: 'var(--error)' }}>
              <span>{i.device?.label || i.device?.qrCode} · {CAT_LABEL[i.category] || i.category}</span>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{i.note || ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Log an issue against a device the staffer just scanned. Issue-only — moves live in MoveFlow.
function IssueSheet({ suiteId, token, staffId, device, onClose, onDone }) {
  const [issue, setIssue] = useState({ category: 'damaged', note: '', resolution: '' });
  const [busy, setBusy] = useState(false);
  async function log() {
    setBusy(true);
    try { await api.eopPortalIssue(suiteId, token, { deviceId: device.id, staffId, ...issue }); onDone('Issue logged'); }
    catch (e) { alert(e.message); setBusy(false); }
  }
  return (
    <div style={overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={sheet}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <strong style={{ fontSize: 16 }}>{device.label || device.qrCode || 'Device'}</strong>
          <button onClick={onClose} style={iconBtn}>✕</button>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>now at {device.state === 'deployed' ? (device.stationName || 'a station') : 'the Hive'}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={lbl}>What&apos;s the issue?</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {ISSUE_CATEGORIES.map((c) => <Pill key={c} on={issue.category === c} onClick={() => setIssue({ ...issue, category: c })}>{CAT_LABEL[c]}</Pill>)}
          </div>
          <textarea style={{ ...input, minHeight: 64 }} placeholder="What's wrong?" value={issue.note} onChange={(e) => setIssue({ ...issue, note: e.target.value })} />
          <input style={input} placeholder="Resolution (optional — if fixed now)" value={issue.resolution} onChange={(e) => setIssue({ ...issue, resolution: e.target.value })} />
          <button onClick={log} disabled={busy} style={bigBtn}>{busy ? 'Saving…' : 'Log issue'}</button>
        </div>
      </div>
    </div>
  );
}

// Station-first move flow: pick the destination, choose Single or Multiple, then scan.
// The logged-in staffer is the actor automatically — no name/number to pick here.
function MoveFlow({ suiteId, token, staffId, stations, onClose, onDone, flash }) {
  const [dest, setDest] = useState(null);   // { id, name, kind } — id 'hive' = back to stock
  const [mode, setMode] = useState(null);   // 'single' | 'multiple'
  const [scanning, setScanning] = useState(false);
  const [scanKey, setScanKey] = useState(0); // bump to remount the one-shot scanner
  const [moved, setMoved] = useState([]);
  const [busy, setBusy] = useState(false);
  const destLabel = dest ? (dest.id === 'hive' ? 'Hive' : dest.name) : '';

  function chooseMode(m) { setMode(m); setScanning(true); setScanKey((k) => k + 1); }
  function scanAgain() { setScanning(true); setScanKey((k) => k + 1); }

  async function onScanned(code) {
    if (!code) { setScanning(false); return; }
    setBusy(true);
    try {
      const r = await api.eopPortalScan(suiteId, token, code);
      const dev = r.device;
      await api.eopPortalMove(suiteId, token, { deviceId: dev.id, stationId: dest.id, staffId });
      const label = dev.label || dev.qrCode || 'Device';
      setMoved((m) => [...m, label]);
      onDone(`${label} → ${destLabel}`);
      if (mode === 'single') { setScanning(false); onClose(); return; }
      setScanKey((k) => k + 1); // fresh scanner for the next device
    } catch (e) {
      flash(e.message || 'Could not move that device');
      if (mode === 'single') { setScanning(false); return; }
      setScanKey((k) => k + 1);
    }
    setBusy(false);
  }

  // Full-screen scanner while actively scanning.
  if (scanning) {
    return (
      <Suspense fallback={null}>
        <EventOpsScanner key={scanKey} onCode={onScanned} onClose={() => setScanning(false)}
          title={`Scan → ${destLabel}${mode === 'multiple' ? ` · ${moved.length} moved` : ''}`} />
      </Suspense>
    );
  }
  return (
    <div style={overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={sheet}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <strong style={{ fontSize: 16 }}>🔀 Move devices</strong>
          <button onClick={onClose} style={iconBtn}>✕</button>
        </div>
        {!dest ? (
          <>
            <div style={lbl}>Where are you moving devices to?</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button onClick={() => setDest({ id: 'hive', name: 'Hive' })} style={destBtn}>🏠 Hive (in stock)</button>
              {stations.map((s) => <button key={s.id} onClick={() => setDest(s)} style={destBtn}>{KIND_ICON[s.kind] || '📍'} {s.name}</button>)}
              {stations.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 13 }}>No stations set up yet.</div>}
            </div>
          </>
        ) : !mode ? (
          <>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>Moving to <strong style={{ color: 'var(--text)' }}>{destLabel}</strong></div>
            <div style={lbl}>How many devices?</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button onClick={() => chooseMode('single')} style={destBtn}>1️⃣ Single — scan one device</button>
              <button onClick={() => chooseMode('multiple')} style={destBtn}>🔢 Multiple — scan several, then finish</button>
            </div>
            <button onClick={() => setDest(null)} style={{ ...ghostBtn, marginTop: 12 }}>← Change destination</button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, marginBottom: 12 }}>{moved.length} device{moved.length === 1 ? '' : 's'} moved to <strong>{destLabel}</strong>.</div>
            {moved.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                {moved.map((m, i) => <div key={i} style={miniRow}><span>{m}</span><span style={{ color: 'var(--success)' }}>✓</span></div>)}
              </div>
            )}
            <button onClick={scanAgain} disabled={busy} style={{ ...bigBtn, marginBottom: 8 }}>📷 Scan another</button>
            <button onClick={onClose} style={ghostBtn}>Done</button>
          </>
        )}
      </div>
    </div>
  );
}

// All issues for the event, filterable; staff can resolve open ones (tiles + comment).
function PortalIssues({ suiteId, token, staffId, onChange, flash }) {
  const [status, setStatus] = useState('open');
  const [issues, setIssues] = useState(null);
  const [resolving, setResolving] = useState(null);
  const load = () => api.eopPortalIssues(suiteId, token, status).then((r) => setIssues(r.issues || [])).catch(() => setIssues([]));
  useEffect(() => { setIssues(null); load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  async function doResolve(resolution) {
    try { await api.eopPortalResolveIssue(suiteId, token, resolving.id, { staffId, resolution }); setResolving(null); load(); onChange?.(); flash?.('Issue resolved'); } catch (e) { alert(e.message); }
  }
  return (
    <div>
      {resolving && <ResolveSheet issue={resolving} onClose={() => setResolving(null)} onResolve={doResolve} />}
      <div style={{ display: 'flex', gap: 6, margin: '4px 0 10px' }}>
        {['open', 'resolved', 'all'].map((s) => <Pill key={s} on={status === s} onClick={() => setStatus(s)}>{s[0].toUpperCase() + s.slice(1)}</Pill>)}
      </div>
      {issues === null ? <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
        : issues.length === 0 ? <div style={{ ...card, color: 'var(--muted)', fontSize: 13 }}>No {status === 'all' ? '' : status} issues.</div>
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {issues.map((i) => (
                <div key={i.id} style={card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 650, fontSize: 14 }}>{i.device?.label || i.device?.qrCode || 'Device'} · <span style={{ color: 'var(--error)' }}>{CAT_LABEL[i.category] || i.category}</span>{i.stationLabel ? <span style={{ color: 'var(--muted)', fontWeight: 500 }}> · 📍 {i.stationLabel}</span> : ''}</div>
                      {i.note && <div style={{ fontSize: 13, marginTop: 2 }}>{i.note}</div>}
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{i.staffLabel ? `${i.staffLabel} · ` : ''}{i.status}</div>
                      {i.status === 'resolved' && i.resolution && <div style={{ fontSize: 12, color: 'var(--success)', marginTop: 4 }}>✓ {i.resolution}</div>}
                    </div>
                    {i.status === 'open' && <button onClick={() => setResolving(i)} style={ghostBtn}>Resolve</button>}
                  </div>
                </div>
              ))}
            </div>
          )}
    </div>
  );
}

function ResolveSheet({ issue, onClose, onResolve }) {
  const [picked, setPicked] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => { const resolution = [picked, comment.trim()].filter(Boolean).join(' — '); setBusy(true); await onResolve(resolution || 'Resolved'); setBusy(false); };
  return (
    <div style={overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={sheet}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <strong style={{ fontSize: 16 }}>Resolve issue</strong>
          <button onClick={onClose} style={iconBtn}>✕</button>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>{issue.device?.label || issue.device?.qrCode} · {CAT_LABEL[issue.category] || issue.category}</div>
        <div style={lbl}>How was it resolved?</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {RESOLUTIONS.map((r) => <Pill key={r} on={picked === r} onClick={() => setPicked(picked === r ? '' : r)}>{r}</Pill>)}
        </div>
        <div style={lbl}>Add a comment (optional)</div>
        <textarea style={{ ...input, minHeight: 56, marginBottom: 12 }} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Any extra detail" />
        <button onClick={submit} disabled={busy || (!picked && !comment.trim())} style={bigBtn}>{busy ? 'Saving…' : 'Mark resolved'}</button>
      </div>
    </div>
  );
}

function CheckpointSheet({ suiteId, token, staffId, stations, checkpoints, myStationIds, onClose, onDone }) {
  const [stationId, setStationId] = useState(myStationIds[0] || '');
  const [checkpointId, setCheckpointId] = useState(checkpoints[0]?.id || '');
  const [comment, setComment] = useState('');
  const [photo, setPhoto] = useState('');
  const [busy, setBusy] = useState(false);
  async function pickPhoto(e) {
    const f = e.target.files?.[0]; if (!f) return;
    try { setPhoto(await downscale(f)); } catch { alert('Could not read that photo.'); }
  }
  async function submit() {
    if (!stationId) { alert('Pick a station.'); return; }
    if (!photo) { alert('A photo is required — tap “Take / choose photo”.'); return; }
    setBusy(true);
    try { await api.eopPortalCheckpoint(suiteId, token, { stationId, checkpointId, comment, photo, staffId }); onDone(); }
    catch (e) { alert(e.message); setBusy(false); }
  }
  const ordered = [...stations].sort((a, b) => (myStationIds.includes(b.id) ? 1 : 0) - (myStationIds.includes(a.id) ? 1 : 0));
  return (
    <div style={overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={sheet}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <strong style={{ fontSize: 16 }}>✅ Checkpoint</strong>
          <button onClick={onClose} style={iconBtn}>✕</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={lbl}>Station</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {ordered.map((s) => <Pill key={s.id} on={stationId === s.id} onClick={() => setStationId(s.id)}>{KIND_ICON[s.kind] || '📍'} {s.name}</Pill>)}
              {ordered.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 13 }}>No stations set up.</div>}
            </div>
          </div>
          {checkpoints.length > 0 && (
            <div>
              <div style={lbl}>Checkpoint</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {checkpoints.map((c) => <Pill key={c.id} on={checkpointId === c.id} onClick={() => setCheckpointId(c.id)}>{c.name}</Pill>)}
              </div>
            </div>
          )}
          <div>
            <div style={lbl}>Comment</div>
            <textarea style={{ ...input, minHeight: 64 }} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Anything to note?" />
          </div>
          <div>
            <div style={lbl}>Photo <span style={{ color: 'var(--error)' }}>(required)</span></div>
            {photo ? (
              <div style={{ position: 'relative' }}>
                <img src={photo} alt="" style={{ width: '100%', maxHeight: 220, objectFit: 'cover', borderRadius: 10 }} />
                <button onClick={() => setPhoto('')} style={{ ...ghostBtn, position: 'absolute', top: 8, right: 8, background: 'var(--card)' }}>Remove</button>
              </div>
            ) : (
              <label style={{ ...destBtn, display: 'inline-block', cursor: 'pointer' }}>
                📷 Take / choose photo
                <input type="file" accept="image/*" capture="environment" onChange={pickPhoto} style={{ display: 'none' }} />
              </label>
            )}
          </div>
          <button onClick={submit} disabled={busy || !stationId || !photo} style={bigBtn}>{busy ? 'Submitting…' : 'Submit checkpoint'}</button>
        </div>
      </div>
    </div>
  );
}

// Downscale a captured image to a small JPEG data-URL before upload (keeps the DB sane).
function downscale(file, max = 1100, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale); const h = Math.round(img.height * scale);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject; img.src = reader.result;
    };
    reader.onerror = reject; reader.readAsDataURL(file);
  });
}

const Center = ({ children }) => <div style={{ ...page, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', color: 'var(--muted)' }}>{children}</div>;
const Pill = ({ on, onClick, children }) => <button onClick={onClick} style={{ padding: '8px 14px', borderRadius: 20, fontSize: 14, fontWeight: on ? 700 : 500, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--brand)' : 'var(--border)'), background: on ? 'var(--brand)' : 'transparent', color: on ? '#fff' : 'var(--text)' }}>{children}</button>;

const page = { minHeight: '100dvh', background: 'var(--bg)', color: 'var(--text)' };
const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 14, padding: 14 };
const kicker = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 8 };
const lbl = { fontSize: 12, color: 'var(--muted)', marginBottom: 6 };
const input = { width: '100%', boxSizing: 'border-box', padding: '12px 14px', fontSize: 15, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' };
const bigBtn = { width: '100%', padding: '13px', borderRadius: 12, border: 'none', background: 'var(--brand)', color: '#fff', fontWeight: 800, fontSize: 16, cursor: 'pointer' };
const secondaryBtn = { width: '100%', padding: '15px', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text)', fontWeight: 700, fontSize: 17, cursor: 'pointer' };
const ghostBtn = { padding: '8px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const destBtn = { textAlign: 'left', padding: '13px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 15, fontWeight: 600, cursor: 'pointer' };
const iconBtn = { width: 34, height: 34, borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 14 };
const badgeBig = { minWidth: 44, height: 44, padding: '0 10px', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(var(--brand-rgb),0.14)', color: 'var(--brand)', fontWeight: 800, fontSize: 16 };
const miniRow = { display: 'flex', justifyContent: 'space-between', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--hairline)', fontSize: 13 };
const overlay = { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const sheet = { width: '100%', maxWidth: 460, maxHeight: '88vh', overflowY: 'auto', background: 'var(--card)', borderRadius: 18, padding: 18, boxShadow: 'var(--shadow-pop)' };
const toastStyle = { position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 1100, background: 'var(--text)', color: 'var(--bg)', padding: '10px 18px', borderRadius: 24, fontSize: 14, fontWeight: 600 };
