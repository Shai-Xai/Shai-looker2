import { useEffect, useState, lazy, Suspense } from 'react';
import { api } from '../lib/api.js';

// PUBLIC staff scan portal — no Pulse account. The per-event token in the URL gates access;
// staff identify by their staff number, then scan to move devices / log issues (attributed
// to them) and see the stations they're posted to. Self-contained; reuses only the scanner.
const EventOpsScanner = lazy(() => import('../components/EventOpsScanner.jsx'));

const KIND_ICON = { bar: '🍺', gate: '🛂', booth: '🏪', topup: '💳', vendor: '🍔', other: '📍' };
const ISSUE_CATEGORIES = ['damaged', 'battery', 'connectivity', 'missing_parts', 'frozen', 'wrong_config', 'other'];
const CAT_LABEL = { damaged: 'Damaged', battery: 'Battery', connectivity: 'Connectivity', missing_parts: 'Missing parts', frozen: 'Frozen', wrong_config: 'Wrong config', other: 'Other' };

export default function EventOpsPortalPage({ suiteId, token }) {
  const [info, setInfo] = useState(null);     // { suite, stations } | { error }
  const [staff, setStaff] = useState(null);   // logged-in staff
  const [me, setMe] = useState(null);         // their stations + devices + issues
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [scanning, setScanning] = useState(false);
  const [device, setDevice] = useState(null); // scanned device → action sheet
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

            <button onClick={() => setScanning(true)} style={{ ...bigBtn, marginBottom: 18, fontSize: 18, padding: '16px' }}>📷 Scan a device</button>

            <div style={kicker}>My stations</div>
            {(!me || me.stations.length === 0) ? (
              <div style={{ ...card, color: 'var(--muted)', fontSize: 13 }}>
                You’re not assigned to a station yet — you can still scan any device to move it or log an issue.
              </div>
            ) : me.stations.map((s) => <StationCard key={s.id} station={s} />)}
          </>
        )}
      </div>

      {scanning && (
        <Suspense fallback={null}>
          <EventOpsScanner onCode={onScanned} onClose={() => setScanning(false)} title="Scan a device" />
        </Suspense>
      )}
      {device && (
        <PortalActionSheet
          suiteId={suiteId} token={token} staffId={staff.id} device={device} stations={info.stations}
          onClose={() => setDevice(null)}
          onDone={(msg) => { setDevice(null); if (msg) flash(msg); refreshMe(); }}
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

function PortalActionSheet({ suiteId, token, staffId, device, stations, onClose, onDone }) {
  const [view, setView] = useState('move');
  const [issue, setIssue] = useState({ category: 'damaged', note: '', resolution: '' });
  const [busy, setBusy] = useState(false);
  async function move(stationId, label) {
    setBusy(true);
    try { await api.eopPortalMove(suiteId, token, { deviceId: device.id, stationId, staffId }); onDone(`${device.label || 'Device'} → ${label}`); }
    catch (e) { alert(e.message); setBusy(false); }
  }
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
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          <Pill on={view === 'move'} onClick={() => setView('move')}>Move</Pill>
          <Pill on={view === 'issue'} onClick={() => setView('issue')}>Log issue</Pill>
        </div>
        {view === 'move' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button disabled={busy} onClick={() => move('hive', 'Hive')} style={destBtn}>🏠 Hive (in stock)</button>
            {stations.map((s) => (
              <button key={s.id} disabled={busy} onClick={() => move(s.id, s.name)} style={destBtn}>{KIND_ICON[s.kind] || '📍'} {s.name}</button>
            ))}
            {stations.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 13 }}>No stations set up yet.</div>}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <select style={input} value={issue.category} onChange={(e) => setIssue({ ...issue, category: e.target.value })}>
              {ISSUE_CATEGORIES.map((c) => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}
            </select>
            <textarea style={{ ...input, minHeight: 64 }} placeholder="What's wrong?" value={issue.note} onChange={(e) => setIssue({ ...issue, note: e.target.value })} />
            <input style={input} placeholder="Resolution (optional — if fixed now)" value={issue.resolution} onChange={(e) => setIssue({ ...issue, resolution: e.target.value })} />
            <button onClick={log} disabled={busy} style={bigBtn}>{busy ? 'Saving…' : 'Log issue'}</button>
          </div>
        )}
      </div>
    </div>
  );
}

const Center = ({ children }) => <div style={{ ...page, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', color: 'var(--muted)' }}>{children}</div>;
const Pill = ({ on, onClick, children }) => <button onClick={onClick} style={{ padding: '8px 14px', borderRadius: 20, fontSize: 14, fontWeight: on ? 700 : 500, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--brand)' : 'var(--border)'), background: on ? 'var(--brand)' : 'transparent', color: on ? '#fff' : 'var(--text)' }}>{children}</button>;

const page = { minHeight: '100dvh', background: 'var(--bg)', color: 'var(--text)' };
const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 14, padding: 14 };
const kicker = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 8 };
const input = { width: '100%', boxSizing: 'border-box', padding: '12px 14px', fontSize: 15, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' };
const bigBtn = { width: '100%', padding: '13px', borderRadius: 12, border: 'none', background: 'var(--brand)', color: '#fff', fontWeight: 800, fontSize: 16, cursor: 'pointer' };
const ghostBtn = { padding: '8px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const destBtn = { textAlign: 'left', padding: '13px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 15, fontWeight: 600, cursor: 'pointer' };
const iconBtn = { width: 34, height: 34, borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 14 };
const badgeBig = { minWidth: 44, height: 44, padding: '0 10px', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(var(--brand-rgb),0.14)', color: 'var(--brand)', fontWeight: 800, fontSize: 16 };
const miniRow = { display: 'flex', justifyContent: 'space-between', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--hairline)', fontSize: 13 };
const overlay = { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const sheet = { width: '100%', maxWidth: 460, maxHeight: '88vh', overflowY: 'auto', background: 'var(--card)', borderRadius: 18, padding: 18, boxShadow: 'var(--shadow-pop)' };
const toastStyle = { position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 1100, background: 'var(--text)', color: 'var(--bg)', padding: '10px 18px', borderRadius: 24, fontSize: 14, fontWeight: 600 };
