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
const catLabel = (c) => CAT_LABEL[c] || String(c || '').replace(/_/g, ' ').replace(/\b\w/g, (x) => x.toUpperCase());
const STATE_LABEL = { in_stock: 'Hive', deployed: 'Deployed', returned: 'Returned', lost: 'Lost', damaged: 'Damaged' };
const whereText = (d) => d.state === 'deployed' ? (d.stationName || (d.holderName ? `with ${d.holderName}` : 'a station')) : 'the Hive';
// One-line description of a device event, mirroring the back-end activity feed.
function feedText(e) {
  const by = e.staffLabel ? ` · ${e.staffLabel}` : '';
  if (e.kind === 'create') return '➕ Added to inventory';
  if (e.kind === 'check') return `⚠️ ${e.note || 'Issue logged'}${by}`;
  if (e.kind === 'status') return `🔁 Marked ${STATE_LABEL[e.toState] || e.toState}${e.unusual ? ' ⚑' : ''}${by}`;
  if (e.toHolder) return `🤝 To ${e.toHolder}${e.toStation ? ` @ ${e.toStation}` : ''}${e.unusual ? ' ⚑' : ''}${by}`;
  const dest = e.toStation || (e.toState === 'in_stock' ? 'Hive' : STATE_LABEL[e.toState] || e.toState);
  const from = e.fromStation || (e.fromState === 'in_stock' ? 'Hive' : STATE_LABEL[e.fromState] || '');
  return `↪️ ${from ? from + ' → ' : ''}${dest}${e.unusual ? ' ⚑' : ''}${by}`;
}
function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
// Collapsible recent-activity list shown after a staffer scans a device.
function PortalActivity({ events = [] }) {
  const [open, setOpen] = useState(false);
  if (!events.length) return null;
  return (
    <div style={{ borderTop: '1px solid var(--hairline)', paddingTop: 10 }}>
      <button onClick={() => setOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: 'transparent', border: 'none', color: 'var(--text)', cursor: 'pointer', padding: 0, fontSize: 13, fontWeight: 700 }}>
        <span>📋 Recent activity ({events.length})</span><span style={{ color: 'var(--muted)' }}>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 0 }}>
          {events.map((e) => (
            <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--hairline)' }}>
              <span style={{ fontSize: 12.5 }}>{feedText(e)}</span>
              <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{timeAgo(e.at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function EventOpsPortalPage({ suiteId, token }) {
  const [info, setInfo] = useState(null);     // { suite, stations } | { error }
  const [staff, setStaff] = useState(null);   // logged-in staff
  const [me, setMe] = useState(null);         // their stations + devices + issues
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [scanning, setScanning] = useState(false); // top-level scan — used to log an issue
  const [device, setDevice] = useState(null); // scanned device → issue sheet
  const [scanEvents, setScanEvents] = useState([]); // scanned device's recent activity
  const [moveScan, setMoveScan] = useState(false); // scanning a device to move it
  const [moveDevice, setMoveDevice] = useState(null); // scanned device → destination picker
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
    try { const r = await api.eopPortalScan(suiteId, token, code); setScanEvents(r.events || []); setDevice(r.device); }
    catch (e2) { flash(e2.message || 'Device not found'); }
  }
  async function onMoveScanned(code) {
    setMoveScan(false);
    if (!code) return;
    try { const r = await api.eopPortalScan(suiteId, token, code); setScanEvents(r.events || []); setMoveDevice(r.device); }
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
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 700 }}>{staff.name || 'Staff'}</div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{staff.role || 'On shift'}</div>
              </div>
              <AlertsToggle suiteId={suiteId} token={token} staffId={staff.id} flash={flash} />
            </div>

            {info.whatsappFrom && (
              <a href={`https://wa.me/${info.whatsappFrom.replace(/[^\d]/g, '')}?text=${encodeURIComponent(`ALERTS ${staff.number || ''}`.trim())}`}
                target="_blank" rel="noopener noreferrer"
                style={{ ...card, display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, textDecoration: 'none', color: 'inherit', borderLeft: '4px solid #25D366' }}>
                <span style={{ fontSize: 22 }}>💬</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>Get alerts on WhatsApp</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>Tap to message <b>{info.whatsappFrom}</b> once — that switches on station alerts here. (We only send alerts; it isn’t a chat line.)</div>
                </div>
                <span style={{ fontSize: 13, color: '#25D366', fontWeight: 800, flexShrink: 0 }}>Open ›</span>
              </a>
            )}

            <MyAlerts suiteId={suiteId} token={token} staffId={staff.id} flash={flash} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
              <button onClick={() => setScanning(true)} style={{ ...bigBtn, fontSize: 17, padding: '15px' }}>⚠️ Log an issue</button>
              {staff.canMove !== false && (
                <button onClick={() => setMoveScan(true)} style={secondaryBtn}>🔀 Move a device</button>
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
          suiteId={suiteId} token={token} staffId={staff.id} device={device} categories={info.issueCategories || []} events={scanEvents}
          onClose={() => setDevice(null)}
          onDone={(msg) => { setDevice(null); if (msg) flash(msg); refreshMe(); }}
        />
      )}
      {moveScan && (
        <Suspense fallback={null}>
          <EventOpsScanner onCode={onMoveScanned} onClose={() => setMoveScan(false)} title="Scan the device to move" />
        </Suspense>
      )}
      {moveDevice && (
        <PortalMoveSheet
          suiteId={suiteId} token={token} staffId={staff.id} device={moveDevice} stations={info.stations} roster={info.staff || []} events={scanEvents}
          onClose={() => setMoveDevice(null)}
          onDone={(msg) => { setMoveDevice(null); if (msg) flash(msg); refreshMe(); }}
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

// 🔔 Opt this phone into station alerts. Web-push, keyed by staff id via the
// token-gated portal routes — no Pulse account. Best-effort: unsupported
// browsers just hide the button.
function b64ToU8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b); const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function AlertsToggle({ suiteId, token, staffId, flash }) {
  const base = `/api/eventops/portal/${encodeURIComponent(suiteId)}/${encodeURIComponent(token)}`;
  const supported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  // iPhone quirk: iOS only allows web-push from an installed (Home Screen) PWA,
  // never a plain Safari tab. Detect that so we can guide instead of hiding.
  const isIOS = typeof navigator !== 'undefined' && /iP(hone|ad|od)/.test(navigator.userAgent);
  const standalone = typeof window !== 'undefined' && (window.navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (!supported) return;
    navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then((s) => setOn(!!s)).catch(() => {});
  }, [supported]);
  if (isIOS && !standalone) {
    return (
      <span style={{ position: 'relative', flexShrink: 0 }}>
        <button onClick={() => setHint((v) => !v)} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 999, padding: '7px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', minHeight: 36 }}>🔔 Alerts</button>
        {hint && (
          <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 20, width: 230, padding: 12, borderRadius: 12, border: '1px solid var(--hairline)', background: 'var(--card)', boxShadow: '0 12px 32px rgba(0,0,0,0.28)', fontSize: 12.5, lineHeight: 1.35 }}>
            To get alerts on iPhone: tap <b>Share</b> ↗ → <b>Add to Home Screen</b>, then open Pulse from that icon and tap 🔔 again.
          </div>
        )}
      </span>
    );
  }
  if (!supported) return null;
  async function enable() {
    setBusy(true);
    try {
      const key = await fetch(`${base}/push-key`).then((r) => r.json());
      if (!key.enabled || !key.publicKey) throw new Error('Alerts are not available right now.');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Turn on notifications for this site in your browser settings.');
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(key.publicKey) });
      await fetch(`${base}/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ staffId, subscription: sub.toJSON() }) });
      setOn(true); flash?.('🔔 Alerts on for this phone');
    } catch (e) { flash?.(e.message || 'Could not turn on alerts'); }
    setBusy(false);
  }
  async function disable() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) { await fetch(`${base}/push-off`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }); await sub.unsubscribe(); }
      setOn(false); flash?.('Alerts off');
    } catch { /* ignore */ }
    setBusy(false);
  }
  return (
    <button onClick={on ? disable : enable} disabled={busy}
      title={on ? 'Alerts on for this phone — tap to turn off' : 'Get station alerts on this phone'}
      style={{ flexShrink: 0, border: `1px solid ${on ? '#16a34a' : 'var(--hairline)'}`, background: on ? 'rgba(22,163,74,0.12)' : 'var(--card)', color: on ? '#16a34a' : 'var(--text)', borderRadius: 999, padding: '7px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', minHeight: 36 }}>
      {busy ? '…' : on ? '🔔 Alerts on' : '🔔 Alerts'}
    </button>
  );
}

// 🚨 A staffer's own station alerts, newest first, with one-tap acknowledge so
// ops can see who's on it. Polls every 60s; token-gated portal routes.
function MyAlerts({ suiteId, token, staffId, flash }) {
  const base = `/api/eventops/portal/${encodeURIComponent(suiteId)}/${encodeURIComponent(token)}/my-alerts/${encodeURIComponent(staffId)}`;
  const [alerts, setAlerts] = useState([]);
  const [busy, setBusy] = useState(false);
  const load = () => fetch(base).then((r) => r.json()).then((d) => setAlerts(d.alerts || [])).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [suiteId, token, staffId]); // eslint-disable-line react-hooks/exhaustive-deps
  const ack = async (alertId) => {
    setBusy(true);
    try { await fetch(`${base}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alertId }) }); flash?.('Acknowledged ✓'); await load(); }
    catch { /* ignore */ }
    setBusy(false);
  };
  if (!alerts.length) return null;
  const unacked = alerts.filter((a) => !a.acked);
  return (
    <div style={{ ...card, borderLeft: `4px solid ${unacked.length ? '#dc2626' : '#16a34a'}`, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontWeight: 800, fontSize: 14 }}>🚨 My station alerts</span>
        {unacked.length > 0 && <span style={{ fontSize: 11.5, fontWeight: 800, color: '#dc2626' }}>{unacked.length} new</span>}
        <span style={{ flex: 1 }} />
        {unacked.length > 1 && <button onClick={() => ack('')} disabled={busy} style={{ border: '1px solid var(--border, #ddd)', background: 'transparent', color: 'inherit', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Ack all</button>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {alerts.slice(0, 8).map((a) => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: a.acked ? 0.55 : 1 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.station}</div>
              <div style={{ fontSize: 12, color: 'var(--muted, #888)' }}>{a.message} · {new Date(a.at).toTimeString().slice(0, 5)}</div>
            </div>
            {a.acked
              ? <span style={{ fontSize: 12, fontWeight: 800, color: '#16a34a', flexShrink: 0 }}>✓ On it</span>
              : <button onClick={() => ack(a.id)} disabled={busy} style={{ border: 'none', background: '#dc2626', color: '#fff', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 800, cursor: 'pointer', flexShrink: 0 }}>I'm on it</button>}
          </div>
        ))}
      </div>
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
              <span>{i.device?.label || i.device?.qrCode} · {catLabel(i.category)}</span>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{i.note || ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Log an issue against a device the staffer just scanned. Issue-only — moves live in MoveFlow.
function IssueSheet({ suiteId, token, staffId, device, categories = [], events = [], onClose, onDone }) {
  const cats = categories.length ? categories.map((c) => c.label) : ISSUE_CATEGORIES;
  const dflt = (categories.find((c) => c.isDefault) || categories[0])?.label || 'damaged';
  const [issue, setIssue] = useState({ category: dflt, note: '', resolution: '' });
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
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>now at {whereText(device)}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={lbl}>What&apos;s the issue?</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {cats.map((c) => <Pill key={c} on={issue.category === c} onClick={() => setIssue({ ...issue, category: c })}>{catLabel(c)}</Pill>)}
          </div>
          <textarea style={{ ...input, minHeight: 64 }} placeholder="What's wrong?" value={issue.note} onChange={(e) => setIssue({ ...issue, note: e.target.value })} />
          <input style={input} placeholder="Resolution (optional — if fixed now)" value={issue.resolution} onChange={(e) => setIssue({ ...issue, resolution: e.target.value })} />
          <button onClick={log} disabled={busy} style={bigBtn}>{busy ? 'Saving…' : 'Log issue'}</button>
          <PortalActivity events={events} />
        </div>
      </div>
    </div>
  );
}

// Simple one-device move for the portal: staff scanned a device, now pick where it goes.
// (The bulk Single/Multiple station-first flow lives on the client console, not here.)
function PortalMoveSheet({ suiteId, token, staffId, device, stations, roster = [], events = [], onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // colleague chosen, awaiting station decision
  async function move(body, label) {
    setBusy(true);
    try { await api.eopPortalMove(suiteId, token, { deviceId: device.id, staffId, ...body }); onDone(`${device.label || 'Device'} → ${label}`); }
    catch (e) { alert(e.message); setBusy(false); }
  }
  const colleagues = roster.filter((s) => s.id !== staffId);
  return (
    <div style={overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={sheet}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <strong style={{ fontSize: 16 }}>{device.label || device.qrCode || 'Device'}</strong>
          <button onClick={onClose} style={iconBtn}>✕</button>
        </div>
        {pending ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>🤝 Hand to {pending.label}</div>
            <div style={lbl}>Are they at a station? Pick one, or hand it over without a station.</div>
            {stations.map((s) => (
              <button key={s.id} disabled={busy} onClick={() => move({ holderStaffId: pending.id, stationId: s.id }, `🤝 ${pending.label} @ ${s.name}`)} style={destBtn}>{KIND_ICON[s.kind] || '📍'} {s.name}</button>
            ))}
            <button disabled={busy} onClick={() => move({ holderStaffId: pending.id }, `🤝 ${pending.label}`)} style={bigBtn}>{busy ? 'Saving…' : 'No station — hand it over'}</button>
            <button disabled={busy} onClick={() => setPending(null)} style={ghostBtn}>Back</button>
          </div>
        ) : (
        <>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>now at {whereText(device)} · send to:</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          <button disabled={busy} onClick={() => move({ stationId: 'hive' }, 'Hive')} style={destBtn}>🏠 Hive (in stock)</button>
          {stations.map((s) => (
            <button key={s.id} disabled={busy} onClick={() => move({ stationId: s.id }, s.name)} style={destBtn}>{KIND_ICON[s.kind] || '📍'} {s.name}</button>
          ))}
          {colleagues.length > 0 && (
            <select value="" disabled={busy} onChange={(e) => { const s = colleagues.find((x) => x.id === e.target.value); if (s) setPending({ id: s.id, label: `${s.number ? `#${s.number} ` : ''}${s.name}` }); }} style={{ ...destBtn, cursor: 'pointer' }}>
              <option value="">🤝 Hand to a colleague…</option>
              {colleagues.map((s) => <option key={s.id} value={s.id}>{s.number ? `#${s.number} ` : ''}{s.name}</option>)}
            </select>
          )}
          {stations.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 13 }}>No stations set up yet.</div>}
        </div>
        <PortalActivity events={events} />
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
                      <div style={{ fontWeight: 650, fontSize: 14 }}>{i.device?.label || i.device?.qrCode || 'Device'} · <span style={{ color: 'var(--error)' }}>{catLabel(i.category)}</span>{i.stationLabel ? <span style={{ color: 'var(--muted)', fontWeight: 500 }}> · 📍 {i.stationLabel}</span> : ''}</div>
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
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>{issue.device?.label || issue.device?.qrCode} · {catLabel(issue.category)}</div>
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
