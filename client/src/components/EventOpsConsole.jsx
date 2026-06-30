import { useEffect, useMemo, useState, lazy, Suspense, Component } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// Event Ops console — live device + station logistics for one event (suite). Mobile-first:
// single column, big tap targets, a persistent Scan button. The SAME component serves both
// surfaces via `scope`: 'admin' (Howler staff, in Admin → client) and 'my' (client self-
// service, /event-ops). Access is enforced server-side; the only scope difference here is
// copy. All writes go through the suite-scoped /api/eventops routes (see server/eventops.js).
const EventOpsScanner = lazy(() => import('./EventOpsScanner.jsx'));

const STATE_LABEL = { in_stock: 'Hive', deployed: 'Deployed', returned: 'Returned', lost: 'Lost', damaged: 'Damaged' };
const STATE_ORDER = ['deployed', 'in_stock', 'returned', 'lost', 'damaged'];
const DEVICE_TYPES = ['handheld', 'kiosk', 'radio', 'printer', 'tablet', 'other'];
const STATION_KINDS = ['bar', 'gate', 'booth', 'topup', 'vendor', 'other'];
const KIND_ICON = { bar: '🍺', gate: '🛂', booth: '🏪', topup: '💳', vendor: '🍔', other: '📍' };
const ISSUE_CATEGORIES = ['damaged', 'battery', 'connectivity', 'missing_parts', 'frozen', 'wrong_config', 'other'];
const CAT_LABEL = { damaged: 'Damaged', battery: 'Battery', connectivity: 'Connectivity', missing_parts: 'Missing parts', frozen: 'Frozen', wrong_config: 'Wrong config', other: 'Other' };

export default function EventOpsConsole({ entityId, scope = 'admin' }) {
  const isMobile = useIsMobile();
  const [suites, setSuites] = useState(null);   // null = loading
  const [suiteId, setSuiteId] = useState('');
  const [canManage, setCanManage] = useState(false);
  const [tab, setTab] = useState('live');
  const [scan, setScan] = useState(null);        // null | { for: 'move' }
  const [actionDevice, setActionDevice] = useState(null); // device shown in the action sheet
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!entityId) { setSuites([]); return; }
    let alive = true;
    api.eventopsSuites(entityId).then((r) => {
      if (!alive) return;
      setSuites(r.suites || []);
      setCanManage(!!r.canManage);
      setSuiteId((cur) => cur || (r.suites?.[0]?.id || ''));
    }).catch(() => alive && setSuites([]));
    return () => { alive = false; };
  }, [entityId]);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 2200); };

  // A scanned/typed code → resolve the device, then open its action sheet.
  async function onScanned(code) {
    setScan(null);
    if (!code) return;
    try {
      const r = await api.eventopsScan(suiteId, code);
      setActionDevice(r.device);
    } catch (e) {
      flash(e.message || 'Device not found');
    }
  }

  if (suites === null) return <div style={{ padding: 24, color: 'var(--muted)' }}>Loading Event Ops…</div>;
  if (!suites.length) {
    return (
      <div style={card}>
        <p style={{ margin: 0, color: 'var(--muted)' }}>
          No events yet{scope === 'my' ? '' : ' for this client'}. Event Ops runs per event — create a suite (event) first, then add devices and stations here.
        </p>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', paddingBottom: 88 }}>
      {/* Event picker + tabs */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 14 }}>
        <label style={{ fontSize: 13, color: 'var(--muted)' }}>Event</label>
        <select value={suiteId} onChange={(e) => setSuiteId(e.target.value)} style={select}>
          {suites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {['live', 'devices', 'stations', 'issues'].map((t) => (
          <button key={t} onClick={() => setTab(t)} style={tabBtn(tab === t)}>
            {t === 'live' ? '📡 Live' : t === 'devices' ? '📟 Devices' : t === 'stations' ? '📍 Stations' : '⚠️ Issues'}
          </button>
        ))}
      </div>

      {suiteId && tab === 'live' && <LiveTab suiteId={suiteId} isMobile={isMobile} />}
      {suiteId && tab === 'devices' && <DevicesTab suiteId={suiteId} canManage={canManage} onAct={setActionDevice} flash={flash} />}
      {suiteId && tab === 'stations' && <StationsTab suiteId={suiteId} canManage={canManage} flash={flash} />}
      {suiteId && tab === 'issues' && <IssuesTab suiteId={suiteId} canManage={canManage} flash={flash} />}

      {/* Persistent Scan button (the on-the-floor primary action) */}
      {canManage && suiteId && (
        <button onClick={() => setScan({ for: 'move' })} style={fab(isMobile)} aria-label="Scan a device">
          <span style={{ fontSize: 20 }}>📷</span> Scan
        </button>
      )}

      {scan && (
        <ScannerBoundary onError={() => { setScan(null); flash('Scanner had a hiccup — tap a device to move/log it, or try Scan again.'); }}>
          <Suspense fallback={null}>
            <EventOpsScanner onCode={onScanned} onClose={() => setScan(null)} />
          </Suspense>
        </ScannerBoundary>
      )}

      {actionDevice && (
        <DeviceActionSheet
          suiteId={suiteId}
          device={actionDevice}
          onClose={() => setActionDevice(null)}
          onDone={(msg) => { setActionDevice(null); if (msg) flash(msg); }}
        />
      )}

      {toast && <div style={toastStyle}>{toast}</div>}
    </div>
  );
}

// ───────────────────────────────── Live tab ──────────────────────────────────
function LiveTab({ suiteId, isMobile }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true;
    setData(null);
    api.eventopsOverview(suiteId).then((d) => alive && setData(d)).catch(() => alive && setData({ error: true }));
    return () => { alive = false; };
  }, [suiteId]);
  if (!data) return <Loading />;
  if (data.error) return <Empty>Couldn’t load the overview.</Empty>;
  const t = data.totals;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4,1fr)', gap: 10 }}>
        <Stat label="Devices" value={t.devices} />
        <Stat label="At Hive" value={t.atHive} />
        <Stat label="Deployed" value={t.deployed} accent="var(--brand)" />
        <Stat label="Open issues" value={t.openIssues} accent={t.openIssues ? 'var(--error)' : undefined} />
      </div>

      <Section title="Stations">
        {data.stations.length === 0 ? <Empty>No stations yet.</Empty> : (
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(3,1fr)', gap: 10 }}>
            {data.stations.map((s) => (
              <div key={s.id} style={stationCard}>
                <div style={{ fontSize: 20 }}>{KIND_ICON[s.kind] || '📍'}</div>
                <div style={{ fontWeight: 650, fontSize: 14 }}>{s.name}</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--brand)' }}>{s.deviceCount}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>device{s.deviceCount === 1 ? '' : 's'}</div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Recent activity">
        {data.recent.length === 0 ? <Empty>Nothing logged yet.</Empty> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {data.recent.map((e) => (
              <div key={e.id} style={feedRow}>
                <span style={{ fontSize: 13 }}>{feedText(e)}</span>
                <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{timeAgo(e.at)}</span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
function feedText(e) {
  if (e.kind === 'create') return '➕ Device added to inventory';
  if (e.kind === 'check') return `⚠️ ${e.note || 'Issue logged'}`;
  if (e.kind === 'status') return `🔁 Marked ${STATE_LABEL[e.toState] || e.toState}${e.unusual ? ' ⚑' : ''}`;
  const dest = e.toStation || (e.toState === 'in_stock' ? 'Hive' : STATE_LABEL[e.toState] || e.toState);
  const from = e.fromStation || (e.fromState === 'in_stock' ? 'Hive' : STATE_LABEL[e.fromState] || '');
  return `↪️ Moved ${from ? from + ' → ' : ''}${dest}${e.unusual ? ' ⚑ unusual' : ''}`;
}

// ──────────────────────────────── Devices tab ─────────────────────────────────
function DevicesTab({ suiteId, canManage, onAct, flash }) {
  const [devices, setDevices] = useState(null);
  const [filter, setFilter] = useState('all');
  const [adding, setAdding] = useState(false);

  const load = () => api.eventopsDevices(suiteId).then((r) => setDevices(r.devices || [])).catch(() => setDevices([]));
  useEffect(() => { setDevices(null); load(); }, [suiteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const c = { all: devices?.length || 0 };
    for (const d of devices || []) c[d.state] = (c[d.state] || 0) + 1;
    return c;
  }, [devices]);
  const shown = (devices || []).filter((d) => filter === 'all' || d.state === filter);

  if (devices === null) return <Loading />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {canManage && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setAdding(true)} style={primaryBtn}>＋ Add devices</button>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Chip on={filter === 'all'} onClick={() => setFilter('all')}>All {counts.all}</Chip>
        {STATE_ORDER.filter((s) => counts[s]).map((s) => (
          <Chip key={s} on={filter === s} onClick={() => setFilter(s)}>{STATE_LABEL[s]} {counts[s]}</Chip>
        ))}
      </div>

      {shown.length === 0 ? <Empty>No devices{filter !== 'all' ? ' in this state' : ' yet'}.</Empty> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.map((d) => (
            <button key={d.id} onClick={() => canManage && onAct(d)} style={deviceRow(canManage)}>
              <div style={{ textAlign: 'left', minWidth: 0 }}>
                <div style={{ fontWeight: 650, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.label || d.qrCode || d.serialNumber || 'Device'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{d.type} · {d.qrCode || d.serialNumber || '—'}</div>
              </div>
              <LocationBadge device={d} />
            </button>
          ))}
        </div>
      )}

      {adding && <AddDevicesModal suiteId={suiteId} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); flash('Devices added'); }} />}
    </div>
  );
}

function LocationBadge({ device }) {
  const deployed = device.state === 'deployed';
  const bg = deployed ? 'rgba(var(--brand-rgb),0.14)' : device.state === 'lost' || device.state === 'damaged' ? 'rgba(220,60,60,0.14)' : 'var(--bg)';
  const color = deployed ? 'var(--brand)' : device.state === 'lost' || device.state === 'damaged' ? 'var(--error)' : 'var(--muted)';
  const text = deployed ? device.stationName || 'Deployed' : device.state === 'in_stock' || device.state === 'returned' ? 'Hive' : STATE_LABEL[device.state];
  return <span style={{ ...badge, background: bg, color, flexShrink: 0 }}>{text}</span>;
}

function AddDevicesModal({ suiteId, onClose, onDone }) {
  const [mode, setMode] = useState('single'); // single | bulk
  const [single, setSingle] = useState({ label: '', qrCode: '', serialNumber: '', type: 'handheld' });
  const [bulk, setBulk] = useState({ prefix: 'SL', start: 1, count: 10, pad: 3, type: 'handheld' });
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      if (mode === 'single') {
        if (!single.label && !single.qrCode && !single.serialNumber) { setBusy(false); return; }
        await api.eventopsCreateDevice(suiteId, single);
      } else {
        await api.eventopsBulkDevices(suiteId, { ...bulk, count: Number(bulk.count), start: Number(bulk.start), pad: Number(bulk.pad) });
      }
      onDone();
    } catch (e) { alert(e.message); setBusy(false); }
  }

  return (
    <Modal title="Add devices" onClose={onClose}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <Chip on={mode === 'single'} onClick={() => setMode('single')}>One device</Chip>
        <Chip on={mode === 'bulk'} onClick={() => setMode('bulk')}>Bulk (auto-number)</Chip>
      </div>
      {mode === 'single' ? (
        <div style={fieldCol}>
          <Field label="Label"><input style={input} value={single.label} onChange={(e) => setSingle({ ...single, label: e.target.value })} placeholder="e.g. SL005" /></Field>
          <Field label="QR code"><input style={input} value={single.qrCode} onChange={(e) => setSingle({ ...single, qrCode: e.target.value })} placeholder="Scannable code" /></Field>
          <Field label="Serial number"><input style={input} value={single.serialNumber} onChange={(e) => setSingle({ ...single, serialNumber: e.target.value })} /></Field>
          <Field label="Type"><TypeSelect value={single.type} onChange={(v) => setSingle({ ...single, type: v })} /></Field>
        </div>
      ) : (
        <div style={fieldCol}>
          <Field label="Code prefix"><input style={input} value={bulk.prefix} onChange={(e) => setBulk({ ...bulk, prefix: e.target.value })} placeholder="SL" /></Field>
          <div style={{ display: 'flex', gap: 8 }}>
            <Field label="Start #"><input style={input} type="number" value={bulk.start} onChange={(e) => setBulk({ ...bulk, start: e.target.value })} /></Field>
            <Field label="How many"><input style={input} type="number" value={bulk.count} onChange={(e) => setBulk({ ...bulk, count: e.target.value })} /></Field>
            <Field label="Digits"><input style={input} type="number" value={bulk.pad} onChange={(e) => setBulk({ ...bulk, pad: e.target.value })} /></Field>
          </div>
          <Field label="Type"><TypeSelect value={bulk.type} onChange={(v) => setBulk({ ...bulk, type: v })} /></Field>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
            Creates {bulk.count || 0} devices: {bulk.prefix}{String(bulk.start || 1).padStart(Number(bulk.pad) || 3, '0')} … {bulk.prefix}{String((Number(bulk.start) || 1) + (Number(bulk.count) || 0) - 1).padStart(Number(bulk.pad) || 3, '0')}
          </p>
        </div>
      )}
      <div style={modalActions}>
        <button onClick={onClose} style={ghostBtn}>Cancel</button>
        <button onClick={submit} disabled={busy} style={primaryBtn}>{busy ? 'Adding…' : 'Add'}</button>
      </div>
    </Modal>
  );
}
const TypeSelect = ({ value, onChange }) => (
  <select style={input} value={value} onChange={(e) => onChange(e.target.value)}>
    {DEVICE_TYPES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
  </select>
);

// ─────────────────────────────── Stations tab ─────────────────────────────────
function StationsTab({ suiteId, canManage, flash }) {
  const [stations, setStations] = useState(null);
  const [form, setForm] = useState(null); // null | {id?, name, kind}
  const load = () => api.eventopsStations(suiteId).then((r) => setStations(r.stations || [])).catch(() => setStations([]));
  useEffect(() => { setStations(null); load(); }, [suiteId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    try {
      if (form.id) await api.eventopsUpdateStation(suiteId, form.id, { name: form.name, kind: form.kind });
      else await api.eventopsCreateStation(suiteId, { name: form.name, kind: form.kind });
      setForm(null); load(); flash('Station saved');
    } catch (e) { alert(e.message); }
  }
  async function remove(s) {
    if (!confirm(`Remove “${s.name}”? Any devices there return to the Hive.`)) return;
    try { await api.eventopsDeleteStation(suiteId, s.id); load(); flash('Station removed'); } catch (e) { alert(e.message); }
  }

  if (stations === null) return <Loading />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {canManage && <button onClick={() => setForm({ name: '', kind: 'bar' })} style={primaryBtn}>＋ Add station</button>}
      {stations.length === 0 ? <Empty>No stations yet.</Empty> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {stations.map((s) => (
            <div key={s.id} style={{ ...deviceRow(false), cursor: 'default' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <span style={{ fontSize: 18 }}>{KIND_ICON[s.kind] || '📍'}</span>
                <div style={{ textAlign: 'left' }}>
                  <div style={{ fontWeight: 650, fontSize: 14 }}>{s.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{s.kind} · {s.deviceCount} device{s.deviceCount === 1 ? '' : 's'}</div>
                </div>
              </div>
              {canManage && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => setForm({ id: s.id, name: s.name, kind: s.kind })} style={iconBtn}>✏️</button>
                  <button onClick={() => remove(s)} style={iconBtn}>🗑️</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {form && (
        <Modal title={form.id ? 'Edit station' : 'Add station'} onClose={() => setForm(null)}>
          <div style={fieldCol}>
            <Field label="Name"><input style={input} value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Main Bar" /></Field>
            <Field label="Kind">
              <select style={input} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {STATION_KINDS.map((k) => <option key={k} value={k}>{KIND_ICON[k]} {k[0].toUpperCase() + k.slice(1)}</option>)}
              </select>
            </Field>
          </div>
          <div style={modalActions}>
            <button onClick={() => setForm(null)} style={ghostBtn}>Cancel</button>
            <button onClick={save} disabled={!form.name.trim()} style={primaryBtn}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ──────────────────────────────── Issues tab ──────────────────────────────────
function IssuesTab({ suiteId, canManage, flash }) {
  const [status, setStatus] = useState('open');
  const [issues, setIssues] = useState(null);
  const load = () => api.eventopsIssues(suiteId, status).then((r) => setIssues(r.issues || [])).catch(() => setIssues([]));
  useEffect(() => { setIssues(null); load(); }, [suiteId, status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function resolve(i) {
    const resolution = prompt('How was it resolved?', i.resolution || '');
    if (resolution === null) return;
    try { await api.eventopsResolveIssue(suiteId, i.id, { resolution }); load(); flash('Issue resolved'); } catch (e) { alert(e.message); }
  }

  if (issues === null) return <Loading />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <Chip on={status === 'open'} onClick={() => setStatus('open')}>Open</Chip>
        <Chip on={status === 'resolved'} onClick={() => setStatus('resolved')}>Resolved</Chip>
        <Chip on={status === 'all'} onClick={() => setStatus('all')}>All</Chip>
      </div>
      {issues.length === 0 ? <Empty>No {status === 'all' ? '' : status} issues.</Empty> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {issues.map((i) => (
            <div key={i.id} style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 14 }}>
                    {i.device?.label || i.device?.qrCode || 'Device'} · <span style={{ color: 'var(--error)' }}>{CAT_LABEL[i.category] || i.category}</span>
                  </div>
                  {i.note && <div style={{ fontSize: 13, color: 'var(--text)', marginTop: 2 }}>{i.note}</div>}
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{i.reportedBy} · {timeAgo(i.reportedAt)}</div>
                  {i.status === 'resolved' && i.resolution && <div style={{ fontSize: 12, color: 'var(--success)', marginTop: 4 }}>✓ {i.resolution}</div>}
                </div>
                {canManage && i.status === 'open' && <button onClick={() => resolve(i)} style={ghostBtn}>Resolve</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────── Device action sheet (move / issue) ────────────────────
function DeviceActionSheet({ suiteId, device, onClose, onDone }) {
  const [stations, setStations] = useState([]);
  const [view, setView] = useState('move'); // move | issue
  const [issue, setIssue] = useState({ category: 'damaged', note: '', resolution: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.eventopsStations(suiteId).then((r) => setStations(r.stations || [])).catch(() => {}); }, [suiteId]);

  async function move(body, label) {
    setBusy(true);
    try { const r = await api.eventopsMove(suiteId, { deviceId: device.id, ...body }); onDone(`${device.label || 'Device'} → ${label}${r.unusual ? ' (⚑ unusual)' : ''}`); }
    catch (e) { alert(e.message); setBusy(false); }
  }
  async function logIssue() {
    setBusy(true);
    try { await api.eventopsLogIssue(suiteId, { deviceId: device.id, ...issue }); onDone('Issue logged'); }
    catch (e) { alert(e.message); setBusy(false); }
  }

  return (
    <Modal title={device.label || device.qrCode || 'Device'} onClose={onClose} subtitle={`${device.type} · now at ${device.state === 'deployed' ? (device.stationName || 'a station') : 'the Hive'}`}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <Chip on={view === 'move'} onClick={() => setView('move')}>Move</Chip>
        <Chip on={view === 'issue'} onClick={() => setView('issue')}>Log issue</Chip>
      </div>

      {view === 'move' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Send to:</div>
          <button disabled={busy} onClick={() => move({ stationId: 'hive' }, 'Hive')} style={destBtn}>🏠 Hive (in stock)</button>
          {stations.map((s) => (
            <button key={s.id} disabled={busy} onClick={() => move({ stationId: s.id }, s.name)} style={destBtn}>
              {KIND_ICON[s.kind] || '📍'} {s.name} <span style={{ color: 'var(--muted)', fontSize: 12 }}>({s.deviceCount})</span>
            </button>
          ))}
          {stations.length === 0 && <Empty>No stations — add one first to deploy devices.</Empty>}
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button disabled={busy} onClick={() => move({ state: 'lost' }, 'Lost')} style={dangerBtn}>Mark lost</button>
            <button disabled={busy} onClick={() => move({ state: 'damaged' }, 'Damaged')} style={dangerBtn}>Mark damaged</button>
          </div>
        </div>
      ) : (
        <div style={fieldCol}>
          <Field label="Issue">
            <select style={input} value={issue.category} onChange={(e) => setIssue({ ...issue, category: e.target.value })}>
              {ISSUE_CATEGORIES.map((c) => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}
            </select>
          </Field>
          <Field label="What's wrong?"><textarea style={{ ...input, minHeight: 60 }} value={issue.note} onChange={(e) => setIssue({ ...issue, note: e.target.value })} /></Field>
          <Field label="Resolution (optional — fill in if fixed now)"><input style={input} value={issue.resolution} onChange={(e) => setIssue({ ...issue, resolution: e.target.value })} placeholder="Leave blank to keep it open" /></Field>
          <div style={modalActions}>
            <button onClick={onClose} style={ghostBtn}>Cancel</button>
            <button onClick={logIssue} disabled={busy} style={primaryBtn}>{busy ? 'Saving…' : 'Log issue'}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// Isolates the camera scanner: if html5-qrcode and React ever fight over the DOM again
// (or the lazy chunk fails to load), this catches it and closes the scanner via onError
// instead of letting the error bubble up and blank the whole page.
class ScannerBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError?.(); }
  render() { return this.state.failed ? null : this.props.children; }
}

// ───────────────────────────────── UI atoms ──────────────────────────────────
const Loading = () => <div style={{ padding: 24, color: 'var(--muted)' }}>Loading…</div>;
const Empty = ({ children }) => <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>{children}</div>;
const Section = ({ title, children }) => (
  <div><div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4, margin: '0 0 8px' }}>{title}</div>{children}</div>
);
const Stat = ({ label, value, accent }) => (
  <div style={{ ...card, padding: 12 }}>
    <div style={{ fontSize: 24, fontWeight: 800, color: accent || 'var(--text)' }}>{value}</div>
    <div style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</div>
  </div>
);
const Chip = ({ on, onClick, children }) => (
  <button onClick={onClick} style={{ padding: '7px 12px', borderRadius: 20, fontSize: 13, fontWeight: on ? 700 : 500, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--brand)' : 'var(--border)'), background: on ? 'var(--brand)' : 'transparent', color: on ? '#fff' : 'var(--text)' }}>{children}</button>
);
const Field = ({ label, children }) => (
  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
    <span style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</span>
    {children}
  </label>
);
function Modal({ title, subtitle, onClose, children }) {
  return (
    <div style={overlay} role="dialog" aria-modal="true" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={modalSheet}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <strong style={{ fontSize: 16 }}>{title}</strong>
            {subtitle && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} style={iconBtn} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ─────────────────────────────────── styles ───────────────────────────────────
const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: 14 };
const stationCard = { ...card, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, textAlign: 'center', padding: 12 };
const select = { padding: '8px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14, maxWidth: '100%' };
const input = { width: '100%', boxSizing: 'border-box', padding: '11px 12px', fontSize: 15, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' };
const fieldCol = { display: 'flex', flexDirection: 'column', gap: 10 };
const tabBtn = (on) => ({ padding: '9px 14px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: on ? 700 : 500, background: on ? 'var(--brand)' : 'var(--card)', color: on ? '#fff' : 'var(--text)' });
const primaryBtn = { padding: '11px 16px', borderRadius: 10, border: 'none', background: 'var(--brand)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' };
const ghostBtn = { padding: '9px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const dangerBtn = { flex: 1, padding: '11px', borderRadius: 10, border: '1px solid rgba(220,60,60,0.4)', background: 'transparent', color: 'var(--error)', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const destBtn = { textAlign: 'left', padding: '13px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 15, fontWeight: 600, cursor: 'pointer' };
const iconBtn = { width: 34, height: 34, borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 14 };
const deviceRow = (clickable) => ({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', padding: '12px 14px', borderRadius: 12, border: '1px solid var(--hairline)', background: 'var(--card)', cursor: clickable ? 'pointer' : 'default' });
const badge = { padding: '5px 10px', borderRadius: 8, fontSize: 12, fontWeight: 700 };
const feedRow = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 4px', borderBottom: '1px solid var(--hairline)' };
const fab = (isMobile) => ({ position: 'fixed', right: isMobile ? 16 : 32, bottom: isMobile ? 16 : 24, zIndex: 60, display: 'flex', alignItems: 'center', gap: 8, padding: '14px 22px', borderRadius: 30, border: 'none', background: 'var(--brand)', color: '#fff', fontWeight: 700, fontSize: 16, cursor: 'pointer', boxShadow: 'var(--shadow-pop)' });
const overlay = { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: 8 };
const modalSheet = { width: '100%', maxWidth: 460, maxHeight: '88vh', overflowY: 'auto', background: 'var(--card)', borderRadius: 18, padding: 18, boxShadow: 'var(--shadow-pop)' };
const modalActions = { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 };
const toastStyle = { position: 'fixed', left: '50%', bottom: 90, transform: 'translateX(-50%)', zIndex: 1100, background: 'var(--text)', color: 'var(--bg)', padding: '10px 18px', borderRadius: 24, fontSize: 14, fontWeight: 600, boxShadow: 'var(--shadow-pop)' };
