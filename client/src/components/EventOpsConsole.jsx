import { useEffect, useMemo, useState, useRef, lazy, Suspense, Component } from 'react';
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
const TABS = [['live', '📡', 'Live'], ['devices', '📟', 'Devices'], ['stations', '📍', 'Stations'], ['map', '🗺️', 'Map'], ['staff', '🧑‍🔧', 'Staff'], ['issues', '⚠️', 'Issues']];

export default function EventOpsConsole({ entityId, scope = 'admin' }) {
  const isMobile = useIsMobile();
  const [suites, setSuites] = useState(null);   // null = loading
  const [suiteId, setSuiteId] = useState('');
  const [canManage, setCanManage] = useState(false);
  const [tab, setTab] = useState('live');
  const [scan, setScan] = useState(null);        // null | { for: 'move' }
  const [actionDevice, setActionDevice] = useState(null); // device shown in the action sheet
  const [stationView, setStationView] = useState(null);   // station whose devices are being viewed
  const [reloadKey, setReloadKey] = useState(0);  // bump → every tab refetches (auto-refresh after an action)
  const [toast, setToast] = useState('');
  const refresh = () => setReloadKey((k) => k + 1);

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
      {/* Event picker */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 16 }}>
        <label style={{ fontSize: 13, color: 'var(--muted)' }}>Event</label>
        <select value={suiteId} onChange={(e) => setSuiteId(e.target.value)} style={select}>
          {suites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      {/* Desktop: left nav rail + full-width content. Mobile: top pills + stacked content. */}
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: isMobile ? 12 : 24, alignItems: 'flex-start' }}>
        <div style={isMobile ? mobileTabs : leftNav}>
          {TABS.map(([t, icon, label]) => (
            <button key={t} onClick={() => setTab(t)} style={isMobile ? tabBtn(tab === t) : navItem(tab === t)}>
              <span style={{ fontSize: 15 }}>{icon}</span> {label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 0, width: '100%' }}>
          {suiteId && tab === 'live' && <LiveTab suiteId={suiteId} isMobile={isMobile} reloadKey={reloadKey} onStation={setStationView} />}
          {suiteId && tab === 'devices' && <DevicesTab suiteId={suiteId} canManage={canManage} onAct={setActionDevice} flash={flash} reloadKey={reloadKey} />}
          {suiteId && tab === 'stations' && <StationsTab suiteId={suiteId} canManage={canManage} flash={flash} reloadKey={reloadKey} onRefresh={refresh} />}
          {suiteId && tab === 'map' && <MapTab suiteId={suiteId} canManage={canManage} isMobile={isMobile} reloadKey={reloadKey} onStation={setStationView} />}
          {suiteId && tab === 'staff' && <StaffTab suiteId={suiteId} canManage={canManage} flash={flash} reloadKey={reloadKey} />}
          {suiteId && tab === 'issues' && <IssuesTab suiteId={suiteId} canManage={canManage} flash={flash} reloadKey={reloadKey} />}
        </div>
      </div>

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

      {stationView && (
        <StationDevicesModal
          suiteId={suiteId}
          station={stationView}
          reloadKey={reloadKey}
          onClose={() => setStationView(null)}
          onDevice={(d) => { setStationView(null); setActionDevice(d); }}
        />
      )}

      {actionDevice && (
        <DeviceActionSheet
          suiteId={suiteId}
          device={actionDevice}
          onClose={() => setActionDevice(null)}
          onDone={(msg) => { setActionDevice(null); if (msg) flash(msg); refresh(); }}
        />
      )}

      {toast && <div style={toastStyle}>{toast}</div>}
    </div>
  );
}

// ───────────────────────────────── Live tab ──────────────────────────────────
function LiveTab({ suiteId, isMobile, reloadKey, onStation }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true;
    setData(null);
    api.eventopsOverview(suiteId).then((d) => alive && setData(d)).catch(() => alive && setData({ error: true }));
    return () => { alive = false; };
  }, [suiteId, reloadKey]);
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
              <button key={s.id} onClick={() => onStation?.(s)} style={{ ...stationCard, cursor: 'pointer' }} title="See devices here">
                <div style={{ fontSize: 20 }}>{KIND_ICON[s.kind] || '📍'}</div>
                <div style={{ fontWeight: 650, fontSize: 14 }}>{s.name}</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--brand)' }}>{s.deviceCount}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>device{s.deviceCount === 1 ? '' : 's'} ›</div>
              </button>
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
  const by = e.staffLabel ? ` · ${e.staffLabel}` : '';
  if (e.kind === 'create') return '➕ Device added to inventory';
  if (e.kind === 'check') return `⚠️ ${e.note || 'Issue logged'}${by}`;
  if (e.kind === 'status') return `🔁 Marked ${STATE_LABEL[e.toState] || e.toState}${e.unusual ? ' ⚑' : ''}${by}`;
  const dest = e.toStation || (e.toState === 'in_stock' ? 'Hive' : STATE_LABEL[e.toState] || e.toState);
  const from = e.fromStation || (e.fromState === 'in_stock' ? 'Hive' : STATE_LABEL[e.fromState] || '');
  return `↪️ Moved ${from ? from + ' → ' : ''}${dest}${e.unusual ? ' ⚑ unusual' : ''}${by}`;
}

// ──────────────────────────────── Devices tab ─────────────────────────────────
function DevicesTab({ suiteId, canManage, onAct, flash, reloadKey }) {
  const [devices, setDevices] = useState(null);
  const [filter, setFilter] = useState('all');         // state filter
  const [stationFilter, setStationFilter] = useState('all'); // location filter (hive | stationId)
  const [adding, setAdding] = useState(false);

  const load = () => api.eventopsDevices(suiteId).then((r) => setDevices(r.devices || [])).catch(() => setDevices([]));
  useEffect(() => { setDevices(null); load(); }, [suiteId, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const c = { all: devices?.length || 0 };
    for (const d of devices || []) c[d.state] = (c[d.state] || 0) + 1;
    return c;
  }, [devices]);
  // Station pills are derived from the devices themselves (Hive = not deployed anywhere).
  const locations = useMemo(() => {
    const m = new Map(); let hive = 0;
    for (const d of devices || []) {
      if (d.stationId) { const e = m.get(d.stationId) || { name: d.stationName, count: 0 }; e.count++; m.set(d.stationId, e); }
      else hive++;
    }
    return { hive, stations: [...m.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => a.name.localeCompare(b.name)) };
  }, [devices]);
  const shown = (devices || []).filter((d) =>
    (filter === 'all' || d.state === filter)
    && (stationFilter === 'all' || (stationFilter === 'hive' ? !d.stationId : d.stationId === stationFilter)));

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
      {/* Station/location filter pills */}
      {(locations.stations.length > 0 || locations.hive > 0) && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Chip on={stationFilter === 'all'} onClick={() => setStationFilter('all')}>All stations</Chip>
          {locations.hive > 0 && <Chip on={stationFilter === 'hive'} onClick={() => setStationFilter('hive')}>🏠 Hive {locations.hive}</Chip>}
          {locations.stations.map((s) => (
            <Chip key={s.id} on={stationFilter === s.id} onClick={() => setStationFilter(s.id)}>{s.name} {s.count}</Chip>
          ))}
        </div>
      )}

      {shown.length === 0 ? <Empty>No devices match this filter.</Empty> : (
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
function StationsTab({ suiteId, canManage, flash, reloadKey, onRefresh }) {
  const [stations, setStations] = useState(null);
  const [form, setForm] = useState(null); // null | {id?, name, kind}
  const load = () => api.eventopsStations(suiteId).then((r) => setStations(r.stations || [])).catch(() => setStations([]));
  useEffect(() => { setStations(null); load(); }, [suiteId, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    try {
      if (form.id) await api.eventopsUpdateStation(suiteId, form.id, { name: form.name, kind: form.kind });
      else await api.eventopsCreateStation(suiteId, { name: form.name, kind: form.kind });
      setForm(null); load(); onRefresh?.(); flash('Station saved');
    } catch (e) { alert(e.message); }
  }
  async function remove(s) {
    if (!confirm(`Remove “${s.name}”? Any devices there return to the Hive.`)) return;
    try { await api.eventopsDeleteStation(suiteId, s.id); load(); onRefresh?.(); flash('Station removed'); } catch (e) { alert(e.message); }
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
function IssuesTab({ suiteId, canManage, flash, reloadKey }) {
  const [status, setStatus] = useState('open');
  const [issues, setIssues] = useState(null);
  const load = () => api.eventopsIssues(suiteId, status).then((r) => setIssues(r.issues || [])).catch(() => setIssues([]));
  useEffect(() => { setIssues(null); load(); }, [suiteId, status, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

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
                    {i.stationLabel && <span style={{ color: 'var(--muted)', fontWeight: 500 }}> · 📍 {i.stationLabel}</span>}
                  </div>
                  {i.note && <div style={{ fontSize: 13, color: 'var(--text)', marginTop: 2 }}>{i.note}</div>}
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                    {i.staffLabel ? `${i.staffLabel} · ` : ''}reported {timeAgo(i.reportedAt)}
                    {i.status === 'open'
                      ? <span style={{ color: 'var(--warn)', fontWeight: 600 }}> · ⏱ open {dur(i.reportedAt)}</span>
                      : <span style={{ color: 'var(--success)' }}> · resolved in {dur(i.reportedAt, i.resolvedAt)}</span>}
                  </div>
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
  const [staff, setStaff] = useState([]);
  const [staffId, setStaffId] = useState(''); // optional attribution — who's doing this
  const [view, setView] = useState('move'); // move | issue
  const [issue, setIssue] = useState({ category: 'damaged', note: '', resolution: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.eventopsStations(suiteId).then((r) => setStations(r.stations || [])).catch(() => {});
    api.eventopsStaff(suiteId).then((r) => setStaff(r.staff || [])).catch(() => {});
  }, [suiteId]);

  async function move(body, label) {
    setBusy(true);
    try { const r = await api.eventopsMove(suiteId, { deviceId: device.id, staffId, ...body }); onDone(`${device.label || 'Device'} → ${label}${r.unusual ? ' (⚑ unusual)' : ''}`); }
    catch (e) { alert(e.message); setBusy(false); }
  }
  async function logIssue() {
    setBusy(true);
    try { await api.eventopsLogIssue(suiteId, { deviceId: device.id, staffId, ...issue }); onDone('Issue logged'); }
    catch (e) { alert(e.message); setBusy(false); }
  }

  return (
    <Modal title={device.label || device.qrCode || 'Device'} onClose={onClose} subtitle={`${device.type} · now at ${device.state === 'deployed' ? (device.stationName || 'a station') : 'the Hive'}`}>
      {/* Who's doing this — optional staff attribution, applies to both move and issue. */}
      {staff.length > 0 && (
        <Field label="Done by (optional)">
          <select style={{ ...input, marginBottom: 12 }} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">— no one in particular —</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.number ? `#${s.number} ` : ''}{s.name}</option>)}
          </select>
        </Field>
      )}
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

// ──────────────────────────── Map tab (venue canvas) ──────────────────────────
// A drag-and-drop floor-plan: station pins positioned by normalised x,y (0..1 of the
// canvas), each showing its live device count. Drag to lay out the venue (persists via
// the station PUT); tap a pin to drill into its devices + issues.
function MapTab({ suiteId, canManage, isMobile, reloadKey, onStation }) {
  const [stations, setStations] = useState(null);
  const [drag, setDrag] = useState(null);      // { id, x, y } live position mid-drag
  const [selected, setSelected] = useState(null); // selected station id (manage mode)
  const canvasRef = useRef(null);

  useEffect(() => {
    setStations(null); setSelected(null);
    api.eventopsStations(suiteId).then((r) => setStations(r.stations || [])).catch(() => setStations([]));
  }, [suiteId, reloadKey]);

  // Stations with no saved coords get spread over a tidy default grid so they're visible.
  const placed = useMemo(() => {
    const list = stations || [];
    const cols = Math.max(1, Math.ceil(Math.sqrt(list.length)));
    const rows = Math.max(1, Math.ceil(list.length / cols));
    return list.map((s, i) => {
      const hasPos = s.x || s.y;
      const x = hasPos ? s.x : (i % cols + 0.5) / cols;
      const y = hasPos ? s.y : (Math.floor(i / cols) + 0.5) / rows;
      return { ...s, _x: x, _y: y };
    });
  }, [stations]);

  // Optimistic local update + persist (used by drag, resize, rotate).
  function patch(id, fields) {
    setStations((prev) => prev.map((st) => (st.id === id ? { ...st, ...fields } : st)));
    api.eventopsUpdateStation(suiteId, id, fields).catch(() => {});
  }

  function startDrag(e, s) {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    let moved = false; let last = { x: s._x, y: s._y };
    const clamp = (v) => Math.min(1, Math.max(0, v));
    const move = (ev) => {
      moved = true;
      last = { x: clamp((ev.clientX - rect.left) / rect.width), y: clamp((ev.clientY - rect.top) / rect.height) };
      setDrag({ id: s.id, ...last });
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      setDrag(null);
      if (moved) patch(s.id, { x: last.x, y: last.y });
      else if (canManage) setSelected(s.id); // tap (no drag) selects → resize/rotate/open
      else onStation?.(s);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  if (stations === null) return <Loading />;
  if (!stations.length) return <Empty>No stations yet — add stations first, then drag them onto the map.</Empty>;
  const sel = (stations || []).find((s) => s.id === selected);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
        {canManage ? 'Drag to move. Tap a station to select it, then resize · rotate · open. ' : 'Tap a station to see its devices & issues.'}
      </div>
      {canManage && sel && (
        <div style={mapToolbar}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>{sel.name}</span>
          <button onClick={() => onStation?.(sel)} style={ghostBtn}>Open</button>
          <span style={tbGroup}>
            <button onClick={() => patch(sel.id, { scale: Math.max(0.4, +(sel.scale || 1) - 0.15) })} style={iconBtn}>－</button>
            <span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 36, textAlign: 'center' }}>{Math.round((sel.scale || 1) * 100)}%</span>
            <button onClick={() => patch(sel.id, { scale: Math.min(3, +(sel.scale || 1) + 0.15) })} style={iconBtn}>＋</button>
          </span>
          <span style={tbGroup}>
            <button onClick={() => patch(sel.id, { rotation: (((sel.rotation || 0) - 15) % 360 + 360) % 360 })} style={iconBtn}>↺</button>
            <button onClick={() => patch(sel.id, { rotation: ((sel.rotation || 0) + 15) % 360 })} style={iconBtn}>↻</button>
          </span>
          <button onClick={() => setSelected(null)} style={ghostBtn}>Done</button>
        </div>
      )}
      <div ref={canvasRef} style={{ ...mapCanvas, height: isMobile ? 440 : 600 }} onPointerDown={(e) => { if (e.target === e.currentTarget) setSelected(null); }}>
        {placed.map((s) => {
          const live = drag && drag.id === s.id ? drag : { x: s._x, y: s._y };
          const isSel = selected === s.id;
          const border = isSel ? 'var(--brand)' : s.openIssues ? 'var(--error)' : s.deviceCount ? 'var(--brand)' : 'var(--border)';
          return (
            <button
              key={s.id}
              onPointerDown={canManage ? (e) => { e.preventDefault(); startDrag(e, s); } : undefined}
              onClick={canManage ? undefined : () => onStation?.(s)}
              style={{ ...mapPin, left: `${live.x * 100}%`, top: `${live.y * 100}%`,
                transform: `translate(-50%, -50%) rotate(${s.rotation || 0}deg) scale(${s.scale || 1})`,
                cursor: canManage ? 'grab' : 'pointer', borderColor: border,
                boxShadow: isSel ? '0 0 0 3px rgba(var(--brand-rgb),0.35)' : 'var(--shadow-sm)' }}
              title={s.name}
            >
              {s.openIssues > 0 && <span style={mapPinIssue}>⚠ {s.openIssues}</span>}
              <span style={{ fontSize: 18, lineHeight: 1 }}>{KIND_ICON[s.kind] || '📍'}</span>
              <span style={{ fontSize: 12, fontWeight: 700, marginTop: 2, maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
              <span style={mapPinCount}>{s.deviceCount}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ───────────────────────────────── Staff tab ──────────────────────────────────
function StaffTab({ suiteId, canManage, flash, reloadKey }) {
  const [staff, setStaff] = useState(null);
  const [stations, setStations] = useState([]);
  const [form, setForm] = useState(null); // null | { id?, name, number, role, stationIds:[] }
  const load = () => api.eventopsStaff(suiteId).then((r) => setStaff(r.staff || [])).catch(() => setStaff([]));
  useEffect(() => { setStaff(null); load(); api.eventopsStations(suiteId).then((r) => setStations(r.stations || [])).catch(() => {}); }, [suiteId, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    try {
      const body = { name: form.name, number: form.number, role: form.role, stationIds: form.stationIds || [] };
      if (form.id) await api.eventopsUpdateStaff(suiteId, form.id, body);
      else await api.eventopsCreateStaff(suiteId, body);
      setForm(null); load(); flash('Staff saved');
    } catch (e) { alert(e.message); }
  }
  async function remove(s) {
    if (!confirm(`Remove ${s.name || s.number}? (Past activity keeps their name.)`)) return;
    try { await api.eventopsDeleteStaff(suiteId, s.id); load(); flash('Staff removed'); } catch (e) { alert(e.message); }
  }
  const toggleStation = (id) => setForm((f) => ({ ...f, stationIds: f.stationIds.includes(id) ? f.stationIds.filter((x) => x !== id) : [...f.stationIds, id] }));

  if (staff === null) return <Loading />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {canManage && <StaffPortalCard suiteId={suiteId} flash={flash} />}
      {canManage && <button onClick={() => setForm({ name: '', number: '', role: '', stationIds: [] })} style={primaryBtn}>＋ Add staff</button>}
      {staff.length === 0 ? <Empty>No staff yet. Add the people working this event so you can tag who moves devices and logs issues.</Empty> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {staff.map((s) => (
            <div key={s.id} style={{ ...deviceRow(false), cursor: 'default' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <span style={staffBadge}>{s.number || '—'}</span>
                <div style={{ textAlign: 'left' }}>
                  <div style={{ fontWeight: 650, fontSize: 14 }}>{s.name || '(no name)'}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{[s.role, s.stations.map((x) => x.name).join(', ')].filter(Boolean).join(' · ') || 'Unassigned'}</div>
                </div>
              </div>
              {canManage && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => setForm({ id: s.id, name: s.name, number: s.number, role: s.role, stationIds: s.stationIds || [] })} style={iconBtn}>✏️</button>
                  <button onClick={() => remove(s)} style={iconBtn}>🗑️</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {form && (
        <Modal title={form.id ? 'Edit staff' : 'Add staff'} onClose={() => setForm(null)}>
          <div style={fieldCol}>
            <div style={{ display: 'flex', gap: 8 }}>
              <Field label="Staff number"><input style={input} value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} placeholder="e.g. 101" /></Field>
              <Field label="Name"><input style={input} value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Jane Doe" /></Field>
            </div>
            <Field label="Role (optional)"><input style={input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} placeholder="e.g. Liaison, Warehouse" /></Field>
            <div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Assigned stations (optional — pick any)</div>
              {stations.length === 0 ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>No stations yet.</div> : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {stations.map((s) => (
                    <Chip key={s.id} on={form.stationIds.includes(s.id)} onClick={() => toggleStation(s.id)}>{KIND_ICON[s.kind] || '📍'} {s.name}</Chip>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div style={modalActions}>
            <button onClick={() => setForm(null)} style={ghostBtn}>Cancel</button>
            <button onClick={save} disabled={!form.name.trim() && !form.number.trim()} style={primaryBtn}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// The shareable staff-portal link (token-gated). Staff open it, log in by number, and scan.
function StaffPortalCard({ suiteId, flash }) {
  const [kiosk, setKiosk] = useState(null);
  useEffect(() => { api.eventopsKiosk(suiteId).then(setKiosk).catch(() => setKiosk({ error: true })); }, [suiteId]);
  if (!kiosk || kiosk.error) return null;
  const url = `${window.location.origin}${kiosk.path}`;
  const copy = () => { try { navigator.clipboard.writeText(url); flash('Portal link copied'); } catch { /* ignore */ } };
  async function rotate() {
    if (!confirm('Generate a new link? The current one will stop working immediately.')) return;
    try { setKiosk(await api.eventopsRotateKiosk(suiteId)); flash('New link generated'); } catch (e) { alert(e.message); }
  }
  async function toggle() {
    try { setKiosk(await api.eventopsSetKiosk(suiteId, !kiosk.enabled)); } catch (e) { alert(e.message); }
  }
  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>🔗 Staff scan portal {kiosk.enabled ? '' : '· off'}</div>
        <button onClick={toggle} style={ghostBtn}>{kiosk.enabled ? 'Turn off' : 'Turn on'}</button>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
        Share this link with on-the-ground staff — they log in with their <b>staff number</b> (no Pulse account), then scan to move devices &amp; log issues, and see their stations.
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <input readOnly value={url} style={{ ...input, flex: 1, minWidth: 180, fontSize: 12.5, opacity: kiosk.enabled ? 1 : 0.5 }} onFocus={(e) => e.target.select()} />
        <button onClick={copy} style={primaryBtn}>Copy</button>
        <button onClick={rotate} style={ghostBtn}>New link</button>
      </div>
    </div>
  );
}

// Drill-down: the devices currently AT a station (tap one to move/log it).
function StationDevicesModal({ suiteId, station, reloadKey, onClose, onDevice }) {
  const [devices, setDevices] = useState(null);
  useEffect(() => {
    api.eventopsDevices(suiteId)
      .then((r) => setDevices((r.devices || []).filter((d) => d.stationId === station.id)))
      .catch(() => setDevices([]));
  }, [suiteId, station.id, reloadKey]);
  return (
    <Modal title={station.name} subtitle={`${KIND_ICON[station.kind] || '📍'} ${station.kind} · devices here now`} onClose={onClose}>
      {devices === null ? <Loading /> : devices.length === 0 ? <Empty>No devices at this station right now.</Empty> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {devices.map((d) => (
            <button key={d.id} onClick={() => onDevice(d)} style={deviceRow(true)}>
              <div style={{ textAlign: 'left', minWidth: 0 }}>
                <div style={{ fontWeight: 650, fontSize: 14 }}>{d.label || d.qrCode || 'Device'}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{d.type} · {d.qrCode || d.serialNumber || '—'}</div>
              </div>
              <span style={{ fontSize: 12, color: 'var(--brand)', fontWeight: 700, whiteSpace: 'nowrap' }}>Move ›</span>
            </button>
          ))}
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
// Duration between two ISO times (or `from`→now). For the issue waiting-time / time-to-resolve.
function dur(fromIso, toIso) {
  if (!fromIso) return '';
  const ms = Math.max(0, (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime());
  const m = Math.floor(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ─────────────────────────────────── styles ───────────────────────────────────
const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: 14 };
const stationCard = { ...card, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, textAlign: 'center', padding: 12 };
const select = { padding: '8px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14, maxWidth: '100%' };
const input = { width: '100%', boxSizing: 'border-box', padding: '11px 12px', fontSize: 15, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' };
const fieldCol = { display: 'flex', flexDirection: 'column', gap: 10 };
const tabBtn = (on) => ({ padding: '9px 14px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: on ? 700 : 500, background: on ? 'var(--brand)' : 'var(--card)', color: on ? '#fff' : 'var(--text)', whiteSpace: 'nowrap' });
const mobileTabs = { display: 'flex', gap: 6, flexWrap: 'wrap' };
const leftNav = { position: 'sticky', top: 8, display: 'flex', flexDirection: 'column', gap: 3, width: 170, flexShrink: 0, padding: 6, borderRadius: 14, border: '1px solid var(--hairline)', background: 'var(--card)' };
const navItem = (on) => ({ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '10px 12px', borderRadius: 9, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: on ? 700 : 500, background: on ? 'var(--brand)' : 'transparent', color: on ? '#fff' : 'var(--text)' });
const primaryBtn = { padding: '11px 16px', borderRadius: 10, border: 'none', background: 'var(--brand)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' };
const ghostBtn = { padding: '9px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const dangerBtn = { flex: 1, padding: '11px', borderRadius: 10, border: '1px solid rgba(220,60,60,0.4)', background: 'transparent', color: 'var(--error)', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const destBtn = { textAlign: 'left', padding: '13px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 15, fontWeight: 600, cursor: 'pointer' };
const iconBtn = { width: 34, height: 34, borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 14 };
const deviceRow = (clickable) => ({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', padding: '12px 14px', borderRadius: 12, border: '1px solid var(--hairline)', background: 'var(--card)', cursor: clickable ? 'pointer' : 'default' });
const badge = { padding: '5px 10px', borderRadius: 8, fontSize: 12, fontWeight: 700 };
const staffBadge = { minWidth: 34, height: 34, padding: '0 8px', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(var(--brand-rgb),0.12)', color: 'var(--brand)', fontWeight: 800, fontSize: 13, flexShrink: 0 };
const feedRow = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 4px', borderBottom: '1px solid var(--hairline)' };
const fab = (isMobile) => ({ position: 'fixed', right: isMobile ? 16 : 32, bottom: isMobile ? 16 : 24, zIndex: 60, display: 'flex', alignItems: 'center', gap: 8, padding: '14px 22px', borderRadius: 30, border: 'none', background: 'var(--brand)', color: '#fff', fontWeight: 700, fontSize: 16, cursor: 'pointer', boxShadow: 'var(--shadow-pop)' });
const mapCanvas = { position: 'relative', width: '100%', borderRadius: 14, border: '1px solid var(--hairline)', background: 'repeating-linear-gradient(0deg, var(--card), var(--card) 23px, var(--hairline) 24px), repeating-linear-gradient(90deg, var(--card), var(--card) 23px, var(--hairline) 24px)', overflow: 'hidden', touchAction: 'none' };
const mapPin = { position: 'absolute', transform: 'translate(-50%, -50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '8px 10px', borderRadius: 12, border: '2px solid var(--border)', background: 'var(--card)', color: 'var(--text)', boxShadow: 'var(--shadow-sm)', userSelect: 'none', touchAction: 'none' };
const mapPinCount = { marginTop: 3, minWidth: 22, padding: '1px 7px', borderRadius: 10, background: 'var(--brand)', color: '#fff', fontSize: 12, fontWeight: 800 };
const mapPinIssue = { position: 'absolute', top: -9, right: -9, padding: '1px 6px', borderRadius: 10, background: 'var(--error)', color: '#fff', fontSize: 11, fontWeight: 800, boxShadow: 'var(--shadow-sm)' };
const mapToolbar = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 10px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--card)' };
const tbGroup = { display: 'flex', alignItems: 'center', gap: 2, padding: 2, borderRadius: 8, border: '1px solid var(--border)' };
const overlay = { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const modalSheet = { width: '100%', maxWidth: 460, maxHeight: '88vh', overflowY: 'auto', background: 'var(--card)', borderRadius: 18, padding: 18, boxShadow: 'var(--shadow-pop)' };
const modalActions = { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 };
const toastStyle = { position: 'fixed', left: '50%', bottom: 90, transform: 'translateX(-50%)', zIndex: 1100, background: 'var(--text)', color: 'var(--bg)', padding: '10px 18px', borderRadius: 24, fontSize: 14, fontWeight: 600, boxShadow: 'var(--shadow-pop)' };
