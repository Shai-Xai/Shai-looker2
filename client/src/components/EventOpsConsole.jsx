import { useEffect, useMemo, useState, useRef, lazy, Suspense, Component } from 'react';
import ReactECharts from 'echarts-for-react/lib/core';
import echarts from '../lib/echarts.js';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// Event Ops console — live device + station logistics for one event (suite). Mobile-first:
// single column, big tap targets, a persistent Scan button. The SAME component serves both
// surfaces via `scope`: 'admin' (Howler staff, in Admin → client) and 'my' (client self-
// service, /event-ops). Access is enforced server-side; the only scope difference here is
// copy. All writes go through the suite-scoped /api/eventops routes (see server/eventops.js).
const EventOpsScanner = lazy(() => import('./EventOpsScanner.jsx'));
// 📶 Data health tab: read-only stream monitors for this entity/event — lazy so
// the console doesn't pay for the Data health module until the tab is opened.
const DataHealthOps = lazy(() => import('./DataHealthAdmin.jsx').then((m) => ({ default: m.DataHealthOps })));
// 🎛 Event Signal: the event as a live site board — zones, stations, device ticks.
const SignalOps = lazy(() => import('./EventSignal.jsx'));
// 🚨 Staff alerts (🧪): board-station ↔ ops-station bridge + who gets called.
const StaffAlertsTab = lazy(() => import('./StaffAlertsTab.jsx'));
const CallsTab = lazy(() => import('./EventOpsCallsTab.jsx'));

const STATE_LABEL = { in_stock: 'Hive', deployed: 'Deployed', returned: 'Returned', lost: 'Lost', damaged: 'Damaged' };
const STATE_ORDER = ['deployed', 'in_stock', 'returned', 'lost', 'damaged'];
const DEVICE_TYPES = ['handheld', 'kiosk', 'radio', 'printer', 'tablet', 'other'];
const STATION_KINDS = ['bar', 'gate', 'booth', 'topup', 'vendor', 'other'];
const KIND_ICON = { bar: '🍺', gate: '🛂', booth: '🏪', topup: '💳', vendor: '🍔', other: '📍' };
const ISSUE_CATEGORIES = ['damaged', 'battery', 'connectivity', 'missing_parts', 'frozen', 'wrong_config', 'other'];
const CAT_LABEL = { damaged: 'Damaged', battery: 'Battery', connectivity: 'Connectivity', missing_parts: 'Missing parts', frozen: 'Frozen', wrong_config: 'Wrong config', other: 'Other' };
// 🐝 The Hive holds the on-the-ground ops surfaces; Data health and the
// Signal board stay top-level. Clicking Hive opens the sub-drawer.
const HIVE_TABS = [['live', '📡', 'Live'], ['devices', '📟', 'Devices'], ['stations', '📍', 'Stations'], ['map', '🗺️', 'Map'], ['staff', '🧑‍🔧', 'Staff'], ['alerts', '🚨', 'Alerts'], ['calls', '📣', 'Calls'], ['checks', '✅', 'Checks'], ['issues', '⚠️', 'Issues'], ['activity', '🧾', 'Activity']];
const TOP_TABS = [['health', '📶', 'Data health']];
// 🎛️ Flow board views — collapse into the left nav like the Hive sub-drawer.
const SIGNAL_VIEWS = [['board', '🎛️', 'Board'], ['rhythm', '📈', 'Rhythm'], ['stations', '📶', 'Stations'], ['flow', '🌡️', 'Flow'], ['map', '🗺️', 'Map'], ['river', '🌊', 'River'], ['network', '🕸️', 'Network']];
// Quick-pick resolutions (staff can also type a custom comment).
const RESOLUTIONS = ['Swapped device', 'Rebooted', 'Battery replaced', 'Reconnected', 'Replaced part', 'Reconfigured', 'Cleared error', 'False alarm'];

export default function EventOpsConsole({ entityId, scope = 'admin' }) {
  const isMobile = useIsMobile();
  const [suites, setSuites] = useState(null);   // null = loading
  const [suiteId, setSuiteId] = useState('');
  const [canManage, setCanManage] = useState(false);
  const [tab, setTab] = useState('live');
  const [hiveOpen, setHiveOpen] = useState(false); // 🐝 sub-drawer closed until tapped — the landing stays 3 buttons
  const inHive = HIVE_TABS.some(([t]) => t === tab);
  const [signalView, setSignalView] = useState('board'); // 🎛️ Flow board view, driven from the nav sub-drawer
  const [signalOpen, setSignalOpen] = useState(false);
  const inSignal = tab === 'signal';
  const [scan, setScan] = useState(null);        // null | { for: 'move' }
  const [moveFlow, setMoveFlow] = useState(false); // station-first Single/Multiple batch move
  const [actionDevice, setActionDevice] = useState(null); // device shown in the action sheet
  const [stationView, setStationView] = useState(null);   // station whose devices are being viewed
  const [heldStaffView, setHeldStaffView] = useState(null); // { staffId, staffLabel } → devices held
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
      {/* Desktop: left nav rail (Event picker on top, then tabs, Scan/Move) + full-width content. Mobile: top pills. */}
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: isMobile ? 12 : 24, alignItems: 'flex-start' }}>
        <div style={isMobile ? { display: 'flex', flexDirection: 'column', gap: 10, width: '100%' } : { display: 'flex', flexDirection: 'column', gap: 8, position: 'sticky', top: 8, width: 170, flexShrink: 0 }}>
          {/* Event picker — desktop: labelled select atop the drawer. Mobile: a compact
              🎫 pill that rides the SAME row as Hive/Data health/Flow board (no full row). */}
          {!isMobile && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <label style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }}>Event</label>
              <select value={suiteId} onChange={(e) => setSuiteId(e.target.value)} style={{ ...select, width: '100%', boxSizing: 'border-box' }}>
                {suites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          <div style={isMobile ? mobileTabs : leftNav}>
            {isMobile && (
              <select value={suiteId} onChange={(e) => setSuiteId(e.target.value)} title="Event" aria-label="Event"
                style={{ ...tabBtn(false), maxWidth: 132, padding: '9px 8px 9px 12px', border: '1px solid var(--hairline)', fontWeight: 700, cursor: 'pointer' }}>
                {suites.map((s) => <option key={s.id} value={s.id}>🎫 {s.name}</option>)}
              </select>
            )}
            <button onClick={() => { if (!inHive) { setTab('live'); setHiveOpen(true); } else setHiveOpen((v) => !v); }}
              style={isMobile ? tabBtn(inHive) : navItem(inHive)}>
              <span style={{ fontSize: 15 }}>🐝</span> Hive <span style={{ fontSize: 10, opacity: 0.7 }}>{hiveOpen ? '▾' : '▸'}</span>
            </button>
            {hiveOpen && (
              <div style={isMobile
                ? { display: 'flex', gap: 6, flexWrap: 'wrap', width: '100%', padding: '2px 0 4px' }
                : { display: 'flex', flexDirection: 'column', gap: 4, marginLeft: 14, paddingLeft: 8, borderLeft: '2px solid var(--hairline)' }}>
                {HIVE_TABS.map(([t, icon, label]) => (
                  <button key={t} onClick={() => setTab(t)} style={{ ...(isMobile ? tabBtn(tab === t) : navItem(tab === t)), fontSize: 12.5 }}>
                    <span style={{ fontSize: 13 }}>{icon}</span> {label}
                  </button>
                ))}
              </div>
            )}
            {TOP_TABS.map(([t, icon, label]) => (
              <button key={t} onClick={() => setTab(t)} style={isMobile ? tabBtn(tab === t) : navItem(tab === t)}>
                <span style={{ fontSize: 15 }}>{icon}</span> {label}
              </button>
            ))}
            {/* 🎛️ Flow board — collapses into its views like the Hive sub-drawer on
                DESKTOP. On mobile that 7-button grid duplicates the board's own compact
                expanding view pill, so we skip it: the tab just opens the board. */}
            <button onClick={() => { if (isMobile) { setTab('signal'); return; } if (!inSignal) { setTab('signal'); setSignalOpen(true); } else setSignalOpen((v) => !v); }}
              style={isMobile ? tabBtn(inSignal) : navItem(inSignal)}>
              <span style={{ fontSize: 15 }}>🎛️</span> Flow board {!isMobile && <span style={{ fontSize: 10, opacity: 0.7 }}>{signalOpen ? '▾' : '▸'}</span>}
            </button>
            {signalOpen && !isMobile && (
              <div style={isMobile
                ? { display: 'flex', gap: 6, flexWrap: 'wrap', width: '100%', padding: '2px 0 4px' }
                : { display: 'flex', flexDirection: 'column', gap: 4, marginLeft: 14, paddingLeft: 8, borderLeft: '2px solid var(--hairline)' }}>
                {SIGNAL_VIEWS.map(([v, icon, label]) => (
                  <button key={v} onClick={() => { setTab('signal'); setSignalView(v); }} style={{ ...(isMobile ? tabBtn(inSignal && signalView === v) : navItem(inSignal && signalView === v)), fontSize: 12.5 }}>
                    <span style={{ fontSize: 13 }}>{icon}</span> {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* Scan + Move are Hive (device-ops) tools — keep them off the
              read-only Data health / Signal board tabs on every screen. */}
          {canManage && suiteId && inHive && (
            <button onClick={() => setScan({ for: 'move' })} style={navScan} aria-label="Scan a device">
              <span style={{ fontSize: 18 }}>📷</span> Scan
            </button>
          )}
          {canManage && suiteId && inHive && (
            <button onClick={() => setMoveFlow(true)} style={navMove} aria-label="Move devices">
              <span style={{ fontSize: 18 }}>🔀</span> Move devices
            </button>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0, width: '100%' }}>
          {suiteId && tab === 'live' && <LiveTab suiteId={suiteId} isMobile={isMobile} reloadKey={reloadKey} onStation={setStationView} onHeldStaff={setHeldStaffView} />}
          {suiteId && tab === 'devices' && <DevicesTab suiteId={suiteId} canManage={canManage} onAct={setActionDevice} flash={flash} reloadKey={reloadKey} />}
          {suiteId && tab === 'stations' && <StationsTab suiteId={suiteId} canManage={canManage} flash={flash} reloadKey={reloadKey} onRefresh={refresh} />}
          {suiteId && tab === 'map' && <MapTab suiteId={suiteId} canManage={canManage} isMobile={isMobile} reloadKey={reloadKey} onStation={setStationView} />}
          {suiteId && tab === 'staff' && <StaffTab suiteId={suiteId} canManage={canManage} flash={flash} reloadKey={reloadKey} onDevice={setActionDevice} />}
          {suiteId && tab === 'alerts' && <Suspense fallback={null}><StaffAlertsTab suiteId={suiteId} /></Suspense>}
          {suiteId && tab === 'calls' && <Suspense fallback={null}><CallsTab suiteId={suiteId} canManage={canManage} /></Suspense>}
          {suiteId && tab === 'checks' && <ChecksTab suiteId={suiteId} canManage={canManage} flash={flash} reloadKey={reloadKey} />}
          {suiteId && tab === 'issues' && <IssuesTab suiteId={suiteId} canManage={canManage} flash={flash} reloadKey={reloadKey} />}
          {suiteId && tab === 'activity' && <ActivityTab suiteId={suiteId} reloadKey={reloadKey} />}
          {suiteId && tab === 'health' && <Suspense fallback={<div style={{ padding: 24, color: 'var(--muted)' }}>Loading data health…</div>}><DataHealthOps entityId={entityId} suiteId={suiteId} /></Suspense>}
          {suiteId && tab === 'signal' && <Suspense fallback={<div style={{ padding: 24, color: 'var(--muted)' }}>Raising the board…</div>}><SignalOps entityId={entityId} suiteId={suiteId} view={signalView} onView={setSignalView} /></Suspense>}
        </div>
      </div>

      {scan && (
        <ScannerBoundary onError={() => { setScan(null); flash('Scanner had a hiccup — tap a device to move/log it, or try Scan again.'); }}>
          <Suspense fallback={null}>
            <EventOpsScanner onCode={onScanned} onClose={() => setScan(null)} />
          </Suspense>
        </ScannerBoundary>
      )}

      {moveFlow && (
        <ConsoleMoveFlow
          suiteId={suiteId}
          onClose={() => setMoveFlow(false)}
          onDone={(msg) => { if (msg) flash(msg); refresh(); }}
          flash={flash}
        />
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

      {heldStaffView && (
        <HeldDevicesModal
          suiteId={suiteId}
          staffId={heldStaffView.staffId}
          label={heldStaffView.staffLabel}
          noStationOnly
          reloadKey={reloadKey}
          onClose={() => setHeldStaffView(null)}
          onDevice={(d) => { setHeldStaffView(null); setActionDevice(d); }}
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
function LiveTab({ suiteId, isMobile, reloadKey, onStation, onHeldStaff }) {
  const [data, setData] = useState(null);
  const [kind, setKind] = useState(null); // null = show chips only · '' = all cards · 'bar' etc = that kind
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

      {(data.stations.length > 0 || t.devices > 0) && (
        <Section title="Devices by location">
          <div style={card}>
            <ReactECharts echarts={echarts} style={{ height: 240 }} opts={{ renderer: 'svg' }} option={devicesByStationOption(data)} notMerge lazyUpdate />
          </div>
        </Section>
      )}

      <Section title="Stations">
        {data.stations.length === 0 ? <Empty>No stations yet.</Empty> : (
          <>
            {/* Chips first — the grid stays collapsed until you pick a type (or
                Show all). Keeps a 60-station event from flooding the landing. */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: kind === null ? 0 : 10 }}>
              <Chip on={kind === ''} onClick={() => setKind(kind === '' ? null : '')}>📋 Show all · {data.stations.length}</Chip>
              {[...new Set(data.stations.map((s) => s.kind))].map((k) => (
                <Chip key={k} on={kind === k} onClick={() => setKind(kind === k ? null : k)}>{KIND_ICON[k] || '📍'} {k[0].toUpperCase() + k.slice(1)} · {data.stations.filter((s) => s.kind === k).length}</Chip>
              ))}
            </div>
            {kind === null ? (
              <div style={{ fontSize: 12, color: 'var(--muted)', padding: '2px 2px 0' }}>Pick a type above to see its stations, or Show all.</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(3,1fr)', gap: 10 }}>
                {data.stations.filter((s) => kind === '' || s.kind === kind).map((s) => (
                  <button key={s.id} onClick={() => onStation?.(s)} style={{ ...stationCard, cursor: 'pointer' }} title="See devices here">
                    <div style={{ fontSize: 20 }}>{KIND_ICON[s.kind] || '📍'}</div>
                    <div style={{ fontWeight: 650, fontSize: 14 }}>{s.name}</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--brand)' }}>{s.deviceCount}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>device{s.deviceCount === 1 ? '' : 's'} ›</div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </Section>

      {data.heldByStaff?.length > 0 && (
        <Section title="With staff">
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(3,1fr)', gap: 10 }}>
            {data.heldByStaff.map((h) => (
              <button key={h.staffId} onClick={() => onHeldStaff?.(h)} style={{ ...stationCard, cursor: 'pointer' }} title="See devices held">
                <div style={{ fontSize: 20 }}>🤝</div>
                <div style={{ fontWeight: 650, fontSize: 14 }}>{h.staffLabel}</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--brand)' }}>{h.count}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>held (no station) ›</div>
              </button>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
// Bar chart: deployed device count per station + the Hive (returns/in-stock).
function devicesByStationOption(data) {
  const cats = [...data.stations.map((s) => s.name), 'Hive'];
  const values = [
    ...data.stations.map((s) => ({ value: s.deviceCount, itemStyle: { color: '#4c8dff', borderRadius: [4, 4, 0, 0] } })),
    { value: data.totals.atHive, itemStyle: { color: '#9aa4b2', borderRadius: [4, 4, 0, 0] } },
  ];
  return {
    grid: { left: 6, right: 12, top: 16, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: { type: 'category', data: cats, axisLabel: { color: '#8a94a6', fontSize: 11, interval: 0, rotate: cats.length > 6 ? 35 : 0 }, axisLine: { lineStyle: { color: '#8a94a6' } } },
    yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#8a94a6', fontSize: 11 }, splitLine: { lineStyle: { color: 'rgba(138,148,166,0.15)' } } },
    series: [{ type: 'bar', data: values, barMaxWidth: 44, label: { show: true, position: 'top', color: '#8a94a6', fontSize: 11 } }],
  };
}
function feedText(e) {
  const by = e.staffLabel ? ` · ${e.staffLabel}` : '';
  if (e.kind === 'create') return '➕ Device added to inventory';
  if (e.kind === 'check') return `⚠️ ${e.note || 'Issue logged'}${by}`;
  if (e.kind === 'status') return `🔁 Marked ${STATE_LABEL[e.toState] || e.toState}${e.unusual ? ' ⚑' : ''}${by}`;
  if (e.toHolder) return `🤝 Handed to ${e.toHolder}${e.toStation ? ` @ ${e.toStation}` : ''}${e.unusual ? ' ⚑' : ''}${by}`;
  const dest = e.toStation || (e.toState === 'in_stock' ? 'Hive' : STATE_LABEL[e.toState] || e.toState);
  const from = e.fromStation || (e.fromState === 'in_stock' ? 'Hive' : STATE_LABEL[e.fromState] || '');
  return `↪️ Moved ${from ? from + ' → ' : ''}${dest}${e.unusual ? ' ⚑ unusual' : ''}${by}`;
}

// ──────────────────────────────── Devices tab ─────────────────────────────────
function DevicesTab({ suiteId, canManage, onAct, flash, reloadKey }) {
  const [devices, setDevices] = useState(null);
  const [filter, setFilter] = useState('all');         // state filter
  const [stationFilter, setStationFilter] = useState('all'); // location filter (hive | stationId)
  const [pairFilter, setPairFilter] = useState('all'); // all | unpaired | paired
  const [q, setQ] = useState('');                      // search
  const [adding, setAdding] = useState(false);
  const [types, setTypes] = useState([]);              // editable device-type catalogue
  const [managingTypes, setManagingTypes] = useState(false);
  const [pairMode, setPairMode] = useState(false);     // tap a device → straight to QR scan
  const [pairingDevice, setPairingDevice] = useState(null);

  const load = () => api.eventopsDevices(suiteId).then((r) => setDevices(r.devices || [])).catch(() => setDevices([]));
  const loadTypes = () => api.eventopsDeviceTypes(suiteId).then((r) => setTypes(r.types || [])).catch(() => setTypes([]));
  useEffect(() => { setDevices(null); load(); loadTypes(); }, [suiteId, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const c = { all: devices?.length || 0, unpaired: 0 };
    for (const d of devices || []) { c[d.state] = (c[d.state] || 0) + 1; if (!d.qrCode) c.unpaired++; }
    return c;
  }, [devices]);
  // Location pills derived from the devices: at a station, held by staff (no station), or Hive.
  const locations = useMemo(() => {
    const m = new Map(); let hive = 0; let withStaff = 0;
    for (const d of devices || []) {
      if (d.stationId) { const e = m.get(d.stationId) || { name: d.stationName, count: 0 }; e.count++; m.set(d.stationId, e); }
      else if (d.holderStaffId) withStaff++;
      else hive++;
    }
    return { hive, withStaff, stations: [...m.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => a.name.localeCompare(b.name)) };
  }, [devices]);
  const needle = q.trim().toLowerCase();
  const shown = (devices || []).filter((d) =>
    (filter === 'all' || d.state === filter)
    && (stationFilter === 'all' || (stationFilter === 'hive' ? (!d.stationId && !d.holderStaffId) : stationFilter === 'staff' ? (!d.stationId && d.holderStaffId) : d.stationId === stationFilter))
    && (pairFilter === 'all' || (pairFilter === 'unpaired' ? !d.qrCode : !!d.qrCode))
    && (!needle || [d.label, d.qrCode, d.serialNumber, d.stationName, d.holderName].some((v) => (v || '').toLowerCase().includes(needle))));

  if (devices === null) return <Loading />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 Search devices (code, label, serial, station)…" style={{ ...input, flex: 1, minWidth: 200 }} />
        {canManage && <button onClick={() => setPairMode((v) => !v)} style={pairMode ? primaryBtn : ghostBtn}>🔗 Pair mode{pairMode ? ' on' : ''}</button>}
        {canManage && <button onClick={() => setManagingTypes(true)} style={ghostBtn}>🏷 Types</button>}
        {canManage && <button onClick={() => setAdding(true)} style={primaryBtn}>＋ Add devices</button>}
      </div>
      {pairMode && (
        <div style={{ ...card, background: 'rgba(var(--brand-rgb),0.10)', border: '1px solid var(--brand)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          🔗 <span><strong>Pair mode is on.</strong> Tap a device to scan &amp; pair its QR code. Turn it off to move/edit devices as usual.</span>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Chip on={filter === 'all'} onClick={() => setFilter('all')}>All {counts.all}</Chip>
        {STATE_ORDER.filter((s) => counts[s]).map((s) => (
          <Chip key={s} on={filter === s} onClick={() => setFilter(s)}>{STATE_LABEL[s]} {counts[s]}</Chip>
        ))}
        {counts.unpaired > 0 && (
          <Chip on={pairFilter === 'unpaired'} onClick={() => setPairFilter(pairFilter === 'unpaired' ? 'all' : 'unpaired')}>🔗 Unpaired {counts.unpaired}</Chip>
        )}
      </div>
      {/* Station/location filter pills */}
      {(locations.stations.length > 0 || locations.hive > 0 || locations.withStaff > 0) && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Chip on={stationFilter === 'all'} onClick={() => setStationFilter('all')}>All stations</Chip>
          {locations.hive > 0 && <Chip on={stationFilter === 'hive'} onClick={() => setStationFilter('hive')}>🏠 Hive {locations.hive}</Chip>}
          {locations.withStaff > 0 && <Chip on={stationFilter === 'staff'} onClick={() => setStationFilter('staff')}>🤝 With staff {locations.withStaff}</Chip>}
          {locations.stations.map((s) => (
            <Chip key={s.id} on={stationFilter === s.id} onClick={() => setStationFilter(s.id)}>{s.name} {s.count}</Chip>
          ))}
        </div>
      )}

      {shown.length === 0 ? <Empty>No devices match this filter.</Empty> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.map((d) => (
            <button key={d.id} onClick={() => canManage && (pairMode ? setPairingDevice(d) : onAct(d))} style={deviceRow(canManage)}>
              <div style={{ textAlign: 'left', minWidth: 0 }}>
                <div style={{ fontWeight: 650, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {pairMode && <span style={{ marginRight: 6 }}>📷</span>}{d.label || d.qrCode || d.serialNumber || 'Device'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {titleCase(d.type)} · {d.qrCode
                    ? <span style={{ color: 'var(--brand)' }}>🔗 {d.qrCode}</span>
                    : <span style={{ color: 'var(--muted)' }}>○ no QR paired</span>}
                  {d.serialNumber ? ` · ${d.serialNumber}` : ''}
                </div>
              </div>
              <LocationBadge device={d} />
            </button>
          ))}
        </div>
      )}

      {adding && <AddDevicesModal suiteId={suiteId} types={types} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); flash('Devices added'); }} />}
      {managingTypes && <ManageTypesModal suiteId={suiteId} types={types} onClose={() => setManagingTypes(false)} onChange={(t) => setTypes(t)} flash={flash} />}
      {pairingDevice && (
        <Suspense fallback={null}>
          <EventOpsScanner
            title={`Pair QR → ${pairingDevice.label || pairingDevice.qrCode || 'device'}`}
            onClose={() => setPairingDevice(null)}
            onCode={async (code) => {
              const qr = String(code || '').trim();
              setPairingDevice(null);
              if (!qr) return;
              try { await api.eventopsUpdateDevice(suiteId, pairingDevice.id, { qrCode: qr }); load(); flash(`Paired ${pairingDevice.label || 'device'} → ${qr}`); }
              catch (e) { alert(e.message); }
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

function LocationBadge({ device }) {
  const deployed = device.state === 'deployed';
  const bg = deployed ? 'rgba(var(--brand-rgb),0.14)' : device.state === 'lost' || device.state === 'damaged' ? 'rgba(220,60,60,0.14)' : 'var(--bg)';
  const color = deployed ? 'var(--brand)' : device.state === 'lost' || device.state === 'damaged' ? 'var(--error)' : 'var(--muted)';
  const text = deployed
    ? (device.stationName || (device.holderName ? `🤝 ${device.holderName}` : 'Deployed'))
    : device.state === 'in_stock' || device.state === 'returned' ? 'Hive' : STATE_LABEL[device.state];
  return <span style={{ ...badge, background: bg, color, flexShrink: 0 }}>{text}</span>;
}

function AddDevicesModal({ suiteId, types = [], onClose, onDone }) {
  const dflt = types[0]?.label || 'handheld';
  const [mode, setMode] = useState('single'); // single | bulk
  const [single, setSingle] = useState({ label: '', qrCode: '', serialNumber: '', type: dflt });
  const [bulk, setBulk] = useState({ prefix: 'SL', start: 1, count: 10, pad: 3, type: dflt });
  const [scanning, setScanning] = useState(false); // scanning a QR to pair while adding
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
          <Field label="QR code">
            <div style={{ display: 'flex', gap: 6 }}>
              <input style={{ ...input, flex: 1 }} value={single.qrCode} onChange={(e) => setSingle({ ...single, qrCode: e.target.value })} placeholder="Scan or type a code" />
              <button type="button" onClick={() => setScanning(true)} style={{ ...ghostBtn, whiteSpace: 'nowrap' }}>📷 Scan</button>
            </div>
          </Field>
          <Field label="Serial number"><input style={input} value={single.serialNumber} onChange={(e) => setSingle({ ...single, serialNumber: e.target.value })} /></Field>
          <Field label="Type"><TypeSelect value={single.type} types={types} onChange={(v) => setSingle({ ...single, type: v })} /></Field>
        </div>
      ) : (
        <div style={fieldCol}>
          <Field label="Code prefix"><input style={input} value={bulk.prefix} onChange={(e) => setBulk({ ...bulk, prefix: e.target.value })} placeholder="SL" /></Field>
          <div style={{ display: 'flex', gap: 8 }}>
            <Field label="Start #"><input style={input} type="number" value={bulk.start} onChange={(e) => setBulk({ ...bulk, start: e.target.value })} /></Field>
            <Field label="How many"><input style={input} type="number" value={bulk.count} onChange={(e) => setBulk({ ...bulk, count: e.target.value })} /></Field>
            <Field label="Digits"><input style={input} type="number" value={bulk.pad} onChange={(e) => setBulk({ ...bulk, pad: e.target.value })} /></Field>
          </div>
          <Field label="Type"><TypeSelect value={bulk.type} types={types} onChange={(v) => setBulk({ ...bulk, type: v })} /></Field>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
            Creates {bulk.count || 0} devices: {bulk.prefix}{String(bulk.start || 1).padStart(Number(bulk.pad) || 3, '0')} … {bulk.prefix}{String((Number(bulk.start) || 1) + (Number(bulk.count) || 0) - 1).padStart(Number(bulk.pad) || 3, '0')}
          </p>
        </div>
      )}
      <div style={modalActions}>
        <button onClick={onClose} style={ghostBtn}>Cancel</button>
        <button onClick={submit} disabled={busy} style={primaryBtn}>{busy ? 'Adding…' : 'Add'}</button>
      </div>
      {scanning && (
        <Suspense fallback={null}>
          <EventOpsScanner onCode={(code) => { setScanning(false); const qr = String(code || '').trim(); if (qr) setSingle((s) => ({ ...s, qrCode: qr })); }} onClose={() => setScanning(false)} title="Scan the device's QR to pair" />
        </Suspense>
      )}
    </Modal>
  );
}
// Type dropdown sourced from the event's editable catalogue. Falls back to the built-in
// defaults if the catalogue hasn't loaded, and always keeps the current value selectable
// (so a device whose type was renamed/removed still shows correctly).
const TypeSelect = ({ value, types = [], onChange }) => {
  const labels = types.length ? types.map((t) => t.label) : DEVICE_TYPES;
  const opts = value && !labels.some((l) => l === value) ? [value, ...labels] : labels;
  return (
    <select style={input} value={value} onChange={(e) => onChange(e.target.value)}>
      {opts.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
    </select>
  );
};
const titleCase = (s) => String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());
const catLabel = (c) => CAT_LABEL[c] || titleCase(String(c || '').replace(/_/g, ' '));

// Add / rename / remove the event's device types. Changes take effect immediately for the
// Type dropdown; renaming re-tags existing devices (server-side) so their type carries over.
function ManageTypesModal({ suiteId, types, onClose, onChange, flash }) {
  const [list, setList] = useState(types);
  const [adding, setAdding] = useState('');
  const [editId, setEditId] = useState(null);
  const [editVal, setEditVal] = useState('');
  const [busy, setBusy] = useState(false);

  async function add() {
    const label = adding.trim(); if (!label) return;
    setBusy(true);
    try { const r = await api.eventopsCreateDeviceType(suiteId, label); setList(r.types); onChange(r.types); setAdding(''); }
    catch (e) { alert(e.message); }
    setBusy(false);
  }
  async function saveEdit(id) {
    const label = editVal.trim(); if (!label) { setEditId(null); return; }
    setBusy(true);
    try { const r = await api.eventopsUpdateDeviceType(suiteId, id, label); setList(r.types); onChange(r.types); setEditId(null); }
    catch (e) { alert(e.message); }
    setBusy(false);
  }
  async function remove(id) {
    setBusy(true);
    try { const r = await api.eventopsDeleteDeviceType(suiteId, id); setList(r.types); onChange(r.types); flash?.('Type removed'); }
    catch (e) { alert(e.message); }
    setBusy(false);
  }

  return (
    <Modal title="Device types" subtitle="Used in the Type dropdown when adding devices" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {list.length === 0 && <Empty>No types yet — add one below.</Empty>}
        {list.map((t) => (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {editId === t.id ? (
              <>
                <input style={{ ...input, flex: 1 }} value={editVal} autoFocus onChange={(e) => setEditVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveEdit(t.id)} />
                <button onClick={() => saveEdit(t.id)} disabled={busy} style={primaryBtn}>Save</button>
                <button onClick={() => setEditId(null)} style={iconBtn}>✕</button>
              </>
            ) : (
              <>
                <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{titleCase(t.label)}</span>
                <button onClick={() => { setEditId(t.id); setEditVal(t.label); }} style={iconBtn}>✏️</button>
                <button onClick={() => remove(t.id)} disabled={busy} style={iconBtn}>🗑️</button>
              </>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
        <input style={{ ...input, flex: 1 }} value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="New type, e.g. Scanner" />
        <button onClick={add} disabled={busy || !adding.trim()} style={primaryBtn}>＋ Add</button>
      </div>
    </Modal>
  );
}

// Add / rename / remove issue categories and star defaults (⭐). More than one can be a
// default; the first starred is pre-selected when logging. Renaming re-tags existing issues.
function ManageCategoriesModal({ suiteId, categories, onClose, onChange, flash }) {
  const [list, setList] = useState(categories);
  const [adding, setAdding] = useState('');
  const [editId, setEditId] = useState(null);
  const [editVal, setEditVal] = useState('');
  const [busy, setBusy] = useState(false);
  const apply = (r) => { setList(r.categories); onChange(r.categories); };

  async function add() {
    const label = adding.trim(); if (!label) return;
    setBusy(true);
    try { apply(await api.eventopsCreateIssueCategory(suiteId, { label, isDefault: list.length === 0 })); setAdding(''); }
    catch (e) { alert(e.message); }
    setBusy(false);
  }
  async function saveEdit(id) {
    const label = editVal.trim(); if (!label) { setEditId(null); return; }
    setBusy(true);
    try { apply(await api.eventopsUpdateIssueCategory(suiteId, id, { label })); setEditId(null); }
    catch (e) { alert(e.message); }
    setBusy(false);
  }
  async function toggleDefault(c) {
    setBusy(true);
    try { apply(await api.eventopsUpdateIssueCategory(suiteId, c.id, { isDefault: !c.isDefault })); }
    catch (e) { alert(e.message); }
    setBusy(false);
  }
  async function remove(id) {
    setBusy(true);
    try { apply(await api.eventopsDeleteIssueCategory(suiteId, id)); flash?.('Category removed'); }
    catch (e) { alert(e.message); }
    setBusy(false);
  }

  return (
    <Modal title="Issue categories" subtitle="Shown when logging an issue · ⭐ = default (pick one or more)" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {list.length === 0 && <Empty>No categories yet — add one below.</Empty>}
        {list.map((c) => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {editId === c.id ? (
              <>
                <input style={{ ...input, flex: 1 }} value={editVal} autoFocus onChange={(e) => setEditVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveEdit(c.id)} />
                <button onClick={() => saveEdit(c.id)} disabled={busy} style={primaryBtn}>Save</button>
                <button onClick={() => setEditId(null)} style={iconBtn}>✕</button>
              </>
            ) : (
              <>
                <button onClick={() => toggleDefault(c)} disabled={busy} title={c.isDefault ? 'A default — tap to unset' : 'Set as a default'} style={{ ...iconBtn, border: 'none', fontSize: 16 }}>{c.isDefault ? '⭐' : '☆'}</button>
                <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{catLabel(c.label)}</span>
                <button onClick={() => { setEditId(c.id); setEditVal(c.label); }} style={iconBtn}>✏️</button>
                <button onClick={() => remove(c.id)} disabled={busy} style={iconBtn}>🗑️</button>
              </>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
        <input style={{ ...input, flex: 1 }} value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="New category, e.g. Overheating" />
        <button onClick={add} disabled={busy || !adding.trim()} style={primaryBtn}>＋ Add</button>
      </div>
    </Modal>
  );
}

// ─────────────────────────────── Stations tab ─────────────────────────────────
function StationsTab({ suiteId, canManage, flash, reloadKey, onRefresh }) {
  const [stations, setStations] = useState(null);
  const [form, setForm] = useState(null); // null | {id?, name, kind}
  const [q, setQ] = useState(''); // find-a-station filter (name or kind)
  const [kf, setKf] = useState(''); // station-type chip filter: '' = all
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
      {stations.length > 6 && (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`🔎 Filter ${stations.length} stations — name or kind…`} aria-label="Filter stations" style={{ ...input, minHeight: 40 }} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Chip on={!kf} onClick={() => setKf('')}>All · {stations.length}</Chip>
            {[...new Set(stations.map((s) => s.kind))].map((k) => (
              <Chip key={k} on={kf === k} onClick={() => setKf(kf === k ? '' : k)}>{KIND_ICON[k] || '📍'} {k[0].toUpperCase() + k.slice(1)} · {stations.filter((s) => s.kind === k).length}</Chip>
            ))}
          </div>
        </>
      )}
      {stations.length === 0 ? <Empty>No stations yet.</Empty> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {stations.filter((s) => (!kf || s.kind === kf) && (!q.trim() || `${s.name} ${s.kind}`.toLowerCase().includes(q.trim().toLowerCase()))).map((s) => (
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
  const [resolving, setResolving] = useState(null); // the issue being resolved
  const [categories, setCategories] = useState([]);
  const [managingCats, setManagingCats] = useState(false);
  const load = () => api.eventopsIssues(suiteId, status).then((r) => setIssues(r.issues || [])).catch(() => setIssues([]));
  const loadCats = () => api.eventopsIssueCategories(suiteId).then((r) => setCategories(r.categories || [])).catch(() => setCategories([]));
  useEffect(() => { setIssues(null); load(); }, [suiteId, status, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadCats(); }, [suiteId, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function doResolve(resolution) {
    try { await api.eventopsResolveIssue(suiteId, resolving.id, { resolution }); setResolving(null); load(); flash('Issue resolved'); } catch (e) { alert(e.message); }
  }

  if (issues === null) return <Loading />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <Chip on={status === 'open'} onClick={() => setStatus('open')}>Open</Chip>
        <Chip on={status === 'resolved'} onClick={() => setStatus('resolved')}>Resolved</Chip>
        <Chip on={status === 'all'} onClick={() => setStatus('all')}>All</Chip>
        {canManage && <button onClick={() => setManagingCats(true)} style={{ ...ghostBtn, marginLeft: 'auto' }}>🏷 Categories</button>}
      </div>
      {managingCats && <ManageCategoriesModal suiteId={suiteId} categories={categories} onClose={() => setManagingCats(false)} onChange={setCategories} flash={flash} />}
      {issues.length === 0 ? <Empty>No {status === 'all' ? '' : status} issues.</Empty> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {issues.map((i) => (
            <div key={i.id} style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 14 }}>
                    {i.device?.label || i.device?.qrCode || 'Device'} · <span style={{ color: 'var(--error)' }}>{catLabel(i.category)}</span>
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
                {canManage && i.status === 'open' && <button onClick={() => setResolving(i)} style={ghostBtn}>Resolve</button>}
              </div>
            </div>
          ))}
        </div>
      )}
      {resolving && <ResolveModal issue={resolving} onClose={() => setResolving(null)} onResolve={doResolve} />}
    </div>
  );
}

// Resolve an issue: pick a quick-pick tile and/or type a comment.
function ResolveModal({ issue, onClose, onResolve }) {
  const [picked, setPicked] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const resolution = [picked, comment.trim()].filter(Boolean).join(' — ');
    setBusy(true); await onResolve(resolution || 'Resolved'); setBusy(false);
  };
  return (
    <Modal title="Resolve issue" subtitle={`${issue.device?.label || issue.device?.qrCode || 'Device'} · ${catLabel(issue.category)}`} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>How was it resolved?</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {RESOLUTIONS.map((r) => <Chip key={r} on={picked === r} onClick={() => setPicked(picked === r ? '' : r)}>{r}</Chip>)}
          </div>
        </div>
        <Field label="Add a comment (optional)"><textarea style={{ ...input, minHeight: 56 }} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Any extra detail" /></Field>
        <div style={modalActions}>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={busy || (!picked && !comment.trim())} style={primaryBtn}>{busy ? 'Saving…' : 'Mark resolved'}</button>
        </div>
      </div>
    </Modal>
  );
}

// ─────────────────────── Device action sheet (move / issue) ────────────────────
function DeviceActionSheet({ suiteId, device, onClose, onDone }) {
  const [stations, setStations] = useState([]);
  const [staff, setStaff] = useState([]);
  const [staffId, setStaffId] = useState(''); // optional attribution — who's doing this
  const [view, setView] = useState('move'); // move | issue | pair | log
  const [categories, setCategories] = useState([]);
  const [issue, setIssue] = useState({ category: '', note: '', resolution: '' });
  const [statusForm, setStatusForm] = useState(null); // { state, comment } when marking lost/damaged
  const [holderPick, setHolderPick] = useState(null); // { id, label } staff chosen, awaiting station choice
  const [pairing, setPairing] = useState(false); // scanner open to pair a QR
  const [manualQr, setManualQr] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [events, setEvents] = useState(null); // this device's full activity log
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.eventopsStations(suiteId).then((r) => setStations(r.stations || [])).catch(() => {});
    api.eventopsStaff(suiteId).then((r) => setStaff(r.staff || [])).catch(() => {});
    api.eventopsDevice(suiteId, device.id).then((r) => setEvents(r.events || [])).catch(() => setEvents([]));
    api.eventopsIssueCategories(suiteId).then((r) => {
      const cats = r.categories || [];
      setCategories(cats);
      setIssue((iss) => iss.category ? iss : { ...iss, category: (cats.find((c) => c.isDefault) || cats[0])?.label || 'damaged' });
    }).catch(() => {});
  }, [suiteId, device.id]);

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
  async function pair(code) {
    setPairing(false);
    const qr = String(code || '').trim();
    if (!qr) return;
    setBusy(true);
    try { const r = await api.eventopsUpdateDevice(suiteId, device.id, { qrCode: qr }); onDone(`Paired to ${r.device?.qrCode || qr}`); }
    catch (e) { alert(e.message); setBusy(false); }
  }
  async function unpair() {
    setBusy(true);
    try { await api.eventopsUpdateDevice(suiteId, device.id, { qrCode: '' }); onDone('QR unpaired'); }
    catch (e) { alert(e.message); setBusy(false); }
  }
  async function del() {
    setBusy(true);
    try { await api.eventopsDeleteDevice(suiteId, device.id); onDone('Device deleted'); }
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
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <Chip on={view === 'move'} onClick={() => setView('move')}>Move</Chip>
        <Chip on={view === 'issue'} onClick={() => setView('issue')}>Log issue</Chip>
        <Chip on={view === 'pair'} onClick={() => { setView('pair'); setPairing(true); }}>🔗 Pair QR</Chip>
        <Chip on={view === 'log'} onClick={() => setView('log')}>📋 Activity{events ? ` (${events.length})` : ''}</Chip>
      </div>

      {view === 'log' ? (
        <DeviceActivity events={events} />
      ) : view === 'move' ? (
        holderPick ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>🤝 Hand to {holderPick.label}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Are they at a station? Pick one, or hand it over without a station.</div>
            {stations.map((s) => (
              <button key={s.id} disabled={busy} onClick={() => move({ holderStaffId: holderPick.id, stationId: s.id }, `🤝 ${holderPick.label} @ ${s.name}`)} style={destBtn}>
                {KIND_ICON[s.kind] || '📍'} {s.name}
              </button>
            ))}
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <button disabled={busy} onClick={() => move({ holderStaffId: holderPick.id }, `🤝 ${holderPick.label}`)} style={primaryBtn}>{busy ? 'Saving…' : 'No station — hand it over'}</button>
              <button disabled={busy} onClick={() => setHolderPick(null)} style={ghostBtn}>Back</button>
            </div>
          </div>
        ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Send to:</div>
          <button disabled={busy} onClick={() => move({ stationId: 'hive' }, 'Hive')} style={destBtn}>🏠 Hive (in stock)</button>
          {stations.map((s) => (
            <button key={s.id} disabled={busy} onClick={() => move({ stationId: s.id }, s.name)} style={destBtn}>
              {KIND_ICON[s.kind] || '📍'} {s.name} <span style={{ color: 'var(--muted)', fontSize: 12 }}>({s.deviceCount})</span>
            </button>
          ))}
          {stations.length === 0 && <Empty>No stations — add one first to deploy devices.</Empty>}
          {staff.length > 0 && (
            <select
              value=""
              disabled={busy}
              onChange={(e) => { const s = staff.find((x) => x.id === e.target.value); if (s) setHolderPick({ id: s.id, label: `${s.number ? `#${s.number} ` : ''}${s.name}` }); }}
              style={{ ...destBtn, cursor: 'pointer' }}
            >
              <option value="">🤝 Hand to a staff member…</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.number ? `#${s.number} ` : ''}{s.name}</option>)}
            </select>
          )}
          {!statusForm ? (
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button disabled={busy} onClick={() => setStatusForm({ state: 'lost', comment: '' })} style={dangerBtn}>Mark lost</button>
              <button disabled={busy} onClick={() => setStatusForm({ state: 'damaged', comment: '' })} style={dangerBtn}>Mark damaged</button>
            </div>
          ) : (
            <div style={{ ...card, marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8, borderColor: 'rgba(220,60,60,0.4)' }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--error)' }}>Mark {statusForm.state} — add a comment</div>
              <textarea style={{ ...input, minHeight: 60 }} autoFocus placeholder="What happened? (e.g. dropped at Gate 2, screen cracked)"
                value={statusForm.comment} onChange={(e) => setStatusForm({ ...statusForm, comment: e.target.value })} />
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button onClick={() => setStatusForm(null)} style={ghostBtn}>Cancel</button>
                <button disabled={busy} onClick={() => move({ state: statusForm.state, note: statusForm.comment }, statusForm.state === 'lost' ? 'Lost' : 'Damaged')} style={primaryBtn}>{busy ? 'Saving…' : `Confirm ${statusForm.state}`}</button>
              </div>
            </div>
          )}
        </div>
        )
      ) : view === 'issue' ? (
        <div style={fieldCol}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Issue</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {(categories.length ? categories.map((c) => c.label) : ISSUE_CATEGORIES).map((c) => (
                <Chip key={c} on={issue.category === c} onClick={() => setIssue({ ...issue, category: c })}>{catLabel(c)}</Chip>
              ))}
            </div>
          </div>
          <Field label="What's wrong?"><textarea style={{ ...input, minHeight: 60 }} value={issue.note} onChange={(e) => setIssue({ ...issue, note: e.target.value })} /></Field>
          <Field label="Resolution (optional — fill in if fixed now)"><input style={input} value={issue.resolution} onChange={(e) => setIssue({ ...issue, resolution: e.target.value })} placeholder="Leave blank to keep it open" /></Field>
          <div style={modalActions}>
            <button onClick={onClose} style={ghostBtn}>Cancel</button>
            <button onClick={logIssue} disabled={busy} style={primaryBtn}>{busy ? 'Saving…' : 'Log issue'}</button>
          </div>
        </div>
      ) : (
        <div style={fieldCol}>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            {device.qrCode
              ? <>Paired to <strong style={{ color: 'var(--text)' }}>{device.qrCode}</strong>. Scan again to re-pair.</>
              : 'No QR paired yet. Scan the sticker on the device to link it — scanning that code will then find this device.'}
          </div>
          <button onClick={() => setPairing(true)} disabled={busy} style={primaryBtn}>📷 Scan QR to pair</button>
          <Field label="…or type the code">
            <div style={{ display: 'flex', gap: 6 }}>
              <input style={{ ...input, flex: 1 }} value={manualQr} onChange={(e) => setManualQr(e.target.value)} placeholder="e.g. QR-00421" />
              <button onClick={() => { pair(manualQr); setManualQr(''); }} disabled={busy || !manualQr.trim()} style={primaryBtn}>Pair</button>
            </div>
          </Field>
          {device.qrCode && (
            <div style={modalActions}>
              <button onClick={unpair} disabled={busy} style={dangerBtn}>{busy ? 'Saving…' : 'Unpair QR'}</button>
            </div>
          )}
        </div>
      )}
      {/* Danger zone — remove the device (and its history) from this event. */}
      <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--hairline)' }}>
        {!confirmDelete ? (
          <button onClick={() => setConfirmDelete(true)} disabled={busy} style={{ ...ghostBtn, color: 'var(--error)' }}>🗑 Delete device</button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12.5, color: 'var(--error)' }}>Delete this device and its full move/issue history? This can’t be undone.</div>
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDelete(false)} disabled={busy} style={ghostBtn}>Cancel</button>
              <button onClick={del} disabled={busy} style={dangerBtn}>{busy ? 'Deleting…' : 'Delete permanently'}</button>
            </div>
          </div>
        )}
      </div>
      {pairing && (
        <Suspense fallback={null}>
          <EventOpsScanner onCode={pair} onClose={() => setPairing(false)} title="Scan the device's QR to pair" />
        </Suspense>
      )}
    </Modal>
  );
}

// A device's full activity log (moves, status changes, checks, creation) — newest first.
function DeviceActivity({ events }) {
  if (events === null) return <Loading />;
  if (!events.length) return <Empty>No activity yet for this device.</Empty>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {events.map((e) => (
        <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--hairline)' }}>
          <span style={{ fontSize: 13 }}>{feedText(e)}</span>
          <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }} title={new Date(e.at).toLocaleString()}>{timeAgo(e.at)}</span>
        </div>
      ))}
    </div>
  );
}

// ─────────────────── Station-first batch move (client console only) ────────────
// Pick the destination (a station or the Hive), optionally who's doing it, then choose
// Single (scan one, done) or Multiple (scan several with a running tally, then finish).
// This bulk flow lives here on the console — the staff portal keeps a simpler one-device move.
function ConsoleMoveFlow({ suiteId, onClose, onDone, flash }) {
  const [stations, setStations] = useState([]);
  const [staff, setStaff] = useState([]);
  const [staffId, setStaffId] = useState('');
  const [dest, setDest] = useState(null);      // { id, name, kind, staff?, stationId? } — id 'hive' = back to stock
  const [pendingStaff, setPendingStaff] = useState(null); // staff chosen, awaiting station decision
  const [mode, setMode] = useState(null);       // 'single' | 'multiple'
  const [scanning, setScanning] = useState(false);
  const [scanKey, setScanKey] = useState(0);    // bump to remount the one-shot scanner
  const [moved, setMoved] = useState([]);
  const [busy, setBusy] = useState(false);
  const destLabel = dest ? (dest.id === 'hive' ? 'Hive' : dest.name) : '';

  useEffect(() => {
    api.eventopsStations(suiteId).then((r) => setStations(r.stations || [])).catch(() => {});
    api.eventopsStaff(suiteId).then((r) => setStaff(r.staff || [])).catch(() => {});
  }, [suiteId]);

  function chooseMode(m) { setMode(m); setScanning(true); setScanKey((k) => k + 1); }
  function scanAgain() { setScanning(true); setScanKey((k) => k + 1); }

  async function onScanned(code) {
    if (!code) { setScanning(false); return; }
    setBusy(true);
    try {
      const dev = (await api.eventopsScan(suiteId, code)).device;
      const moveBody = dest.staff ? { deviceId: dev.id, holderStaffId: dest.id, stationId: dest.stationId, staffId } : { deviceId: dev.id, stationId: dest.id, staffId };
      const mv = await api.eventopsMove(suiteId, moveBody);
      const label = dev.label || dev.qrCode || 'Device';
      setMoved((m) => [...m, label]);
      onDone(`${label} → ${destLabel}${mv.unusual ? ' (⚑ unusual)' : ''}`);
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
      <ScannerBoundary onError={() => { setScanning(false); flash('Scanner had a hiccup — try again.'); }}>
        <Suspense fallback={null}>
          <EventOpsScanner key={scanKey} onCode={onScanned} onClose={() => setScanning(false)}
            onDone={mode === 'multiple' ? () => { setScanning(false); onClose(); } : undefined}
            doneLabel={`✓ Done${moved.length ? ` (${moved.length})` : ''}`}
            title={`Scan → ${destLabel}${mode === 'multiple' ? ` · ${moved.length} moved` : ''}`} />
        </Suspense>
      </ScannerBoundary>
    );
  }
  return (
    <Modal title="🔀 Move devices" subtitle={dest ? `To ${destLabel}` : 'Pick where the devices are going'} onClose={onClose}>
      {!dest ? (
        pendingStaff ? (
          <div style={fieldCol}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>🤝 Hand to {pendingStaff.name}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Are they at a station? Pick one, or hand it over without a station.</div>
            {stations.map((s) => (
              <button key={s.id} onClick={() => setDest({ id: pendingStaff.id, name: `${pendingStaff.name} @ ${s.name}`, staff: true, stationId: s.id })} style={destBtn}>{KIND_ICON[s.kind] || '📍'} {s.name}</button>
            ))}
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <button onClick={() => setDest({ id: pendingStaff.id, name: pendingStaff.name, staff: true })} style={primaryBtn}>No station — just hand it over</button>
              <button onClick={() => setPendingStaff(null)} style={ghostBtn}>Back</button>
            </div>
          </div>
        ) : (
        <div style={fieldCol}>
          {staff.length > 0 && (
            <Field label="Done by (optional)">
              <select style={input} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
                <option value="">— no one in particular —</option>
                {staff.map((s) => <option key={s.id} value={s.id}>{s.number ? `#${s.number} ` : ''}{s.name}</option>)}
              </select>
            </Field>
          )}
          <div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Move devices to:</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button onClick={() => setDest({ id: 'hive', name: 'Hive' })} style={destBtn}>🏠 Hive (in stock)</button>
              {stations.map((s) => (
                <button key={s.id} onClick={() => setDest(s)} style={destBtn}>{KIND_ICON[s.kind] || '📍'} {s.name} <span style={{ color: 'var(--muted)', fontSize: 12 }}>({s.deviceCount})</span></button>
              ))}
              {staff.length > 0 && (
                <select value="" onChange={(e) => { const s = staff.find((x) => x.id === e.target.value); if (s) setPendingStaff({ id: s.id, name: `${s.number ? `#${s.number} ` : ''}${s.name}` }); }} style={{ ...destBtn, cursor: 'pointer' }}>
                  <option value="">🤝 A staff member…</option>
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.number ? `#${s.number} ` : ''}{s.name}</option>)}
                </select>
              )}
              {stations.length === 0 && <Empty>No stations — add one first to deploy devices.</Empty>}
            </div>
          </div>
        </div>
        )
      ) : !mode ? (
        <div style={fieldCol}>
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Moving to <strong style={{ color: 'var(--text)' }}>{destLabel}</strong>. How many devices?</div>
          <button onClick={() => chooseMode('single')} style={destBtn}>1️⃣ Single — scan one device, done</button>
          <button onClick={() => chooseMode('multiple')} style={destBtn}>🔢 Multiple — scan several, then finish</button>
          <button onClick={() => { setDest(null); setPendingStaff(null); }} style={ghostBtn}>← Change destination</button>
        </div>
      ) : (
        <div style={fieldCol}>
          <div style={{ fontSize: 13 }}>{moved.length} device{moved.length === 1 ? '' : 's'} moved to <strong>{destLabel}</strong>.</div>
          {moved.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {moved.map((m, i) => <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--hairline)', fontSize: 13 }}><span>{m}</span><span style={{ color: 'var(--success)' }}>✓</span></div>)}
            </div>
          )}
          <button onClick={scanAgain} disabled={busy} style={primaryBtn}>📷 Scan another</button>
          <button onClick={onClose} style={ghostBtn}>Done</button>
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
  const canvasRef = useRef(null);

  useEffect(() => {
    setStations(null);
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
      else onStation?.(s); // a tap (no drag) opens the drawer
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  if (stations === null) return <Loading />;
  if (!stations.length) return <Empty>No stations yet — add stations first, then drag them onto the map.</Empty>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
        Tap a station to see its devices &amp; issues.{canManage ? ' Drag to move; use the ± and ↺↻ handles on a station to resize / rotate it.' : ''}
      </div>
      <div ref={canvasRef} style={{ ...mapCanvas, height: isMobile ? 440 : 600 }}>
        {placed.map((s) => {
          const live = drag && drag.id === s.id ? drag : { x: s._x, y: s._y };
          const rot = s.rotation || 0; const sc = s.scale || 1;
          const border = s.openIssues ? 'var(--error)' : s.deviceCount ? 'var(--brand)' : 'var(--border)';
          const bump = (fields, ev) => { ev.stopPropagation(); patch(s.id, fields); };
          return (
            <div
              key={s.id}
              title={s.name}
              onPointerDown={canManage ? (e) => { if (e.target.closest('[data-ctrl]')) return; e.preventDefault(); startDrag(e, s); } : undefined}
              onClick={canManage ? undefined : () => onStation?.(s)}
              style={{ ...mapPin, left: `${live.x * 100}%`, top: `${live.y * 100}%`,
                transform: `translate(-50%, -50%) rotate(${rot}deg) scale(${sc})`,
                cursor: canManage ? 'grab' : 'pointer', borderColor: border }}
            >
              {s.openIssues > 0 && <span style={mapPinIssue}>⚠ {s.openIssues}</span>}
              <span style={{ fontSize: 18, lineHeight: 1 }}>{KIND_ICON[s.kind] || '📍'}</span>
              <span style={{ fontSize: 12, fontWeight: 700, marginTop: 2, maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
              <span style={mapPinCount}>{s.deviceCount}</span>
              {canManage && (
                // Resize / rotate handles ON the tile. Counter-transform keeps them upright &
                // a constant size regardless of the tile's own scale/rotation. stopPropagation
                // so a handle tap never starts a drag or opens the drawer.
                <div data-ctrl onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
                  style={{ ...pinCtrls, transform: `rotate(${-rot}deg) scale(${1 / sc})` }}>
                  <button style={pinCtrlBtn} title="Smaller" onClick={(e) => bump({ scale: Math.max(0.4, +sc - 0.15) }, e)}>－</button>
                  <button style={pinCtrlBtn} title="Bigger" onClick={(e) => bump({ scale: Math.min(3, +sc + 0.15) }, e)}>＋</button>
                  <button style={pinCtrlBtn} title="Rotate left" onClick={(e) => bump({ rotation: ((rot - 15) % 360 + 360) % 360 }, e)}>↺</button>
                  <button style={pinCtrlBtn} title="Rotate right" onClick={(e) => bump({ rotation: (rot + 15) % 360 }, e)}>↻</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ───────────────────────────────── Staff tab ──────────────────────────────────
function StaffTab({ suiteId, canManage, flash, reloadKey, onDevice }) {
  const [staff, setStaff] = useState(null);
  const [stations, setStations] = useState([]);
  const [devices, setDevices] = useState([]);
  const [stationFilter, setStationFilter] = useState('all'); // all | unassigned | stationId
  const [form, setForm] = useState(null); // null | { id?, name, number, role, stationIds:[] }
  const [stq, setStq] = useState(''); // filter for the assigned-stations chip picker
  const [heldFor, setHeldFor] = useState(null); // staff whose held devices are being viewed
  const load = () => api.eventopsStaff(suiteId).then((r) => setStaff(r.staff || [])).catch(() => setStaff([]));
  useEffect(() => { setStaff(null); load(); api.eventopsStations(suiteId).then((r) => setStations(r.stations || [])).catch(() => {}); api.eventopsDevices(suiteId).then((r) => setDevices(r.devices || [])).catch(() => {}); }, [suiteId, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const heldCount = useMemo(() => { const m = {}; for (const d of devices) if (d.holderStaffId) m[d.holderStaffId] = (m[d.holderStaffId] || 0) + 1; return m; }, [devices]);

  async function save() {
    try {
      const body = { name: form.name, number: form.number, role: form.role, stationIds: form.stationIds || [], canMove: !!form.canMove, canCheckpoint: !!form.canCheckpoint, alertsOn: form.alertsOn !== false };
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

  const counts = useMemo(() => {
    const c = { all: staff?.length || 0, unassigned: 0 }; const byStation = {};
    for (const s of staff || []) {
      if (!s.stationIds?.length) c.unassigned++;
      for (const id of s.stationIds || []) byStation[id] = (byStation[id] || 0) + 1;
    }
    return { ...c, byStation };
  }, [staff]);
  const shownStaff = (staff || []).filter((s) =>
    stationFilter === 'all' ? true : stationFilter === 'unassigned' ? !s.stationIds?.length : (s.stationIds || []).includes(stationFilter));

  if (staff === null) return <Loading />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {canManage && <StaffPortalCard suiteId={suiteId} flash={flash} />}
      {canManage && <button onClick={() => setForm({ name: '', number: '', role: '', stationIds: [], canMove: true, canCheckpoint: false, alertsOn: true })} style={primaryBtn}>＋ Add staff</button>}
      {/* Filter staff by the station they're posted to. */}
      {stations.length > 0 && staff.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Chip on={stationFilter === 'all'} onClick={() => setStationFilter('all')}>All {counts.all}</Chip>
          {stations.filter((s) => counts.byStation[s.id]).map((s) => (
            <Chip key={s.id} on={stationFilter === s.id} onClick={() => setStationFilter(s.id)}>{KIND_ICON[s.kind] || '📍'} {s.name} {counts.byStation[s.id]}</Chip>
          ))}
          {counts.unassigned > 0 && <Chip on={stationFilter === 'unassigned'} onClick={() => setStationFilter('unassigned')}>Unassigned {counts.unassigned}</Chip>}
        </div>
      )}
      {staff.length === 0 ? <Empty>No staff yet. Add the people working this event so you can tag who moves devices and logs issues.</Empty> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shownStaff.map((s) => (
            <div key={s.id} style={{ ...deviceRow(false), cursor: 'default' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <span style={staffBadge}>{s.number || '—'}</span>
                <div style={{ textAlign: 'left' }}>
                  <div style={{ fontWeight: 650, fontSize: 14 }}>{s.name || '(no name)'}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{[s.role, s.stations.map((x) => x.name).join(', ')].filter(Boolean).join(' · ') || 'Unassigned'}</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {heldCount[s.id] > 0 && (
                  <button onClick={() => setHeldFor(s)} style={{ ...badge, background: 'rgba(var(--brand-rgb),0.14)', color: 'var(--brand)', border: 'none', cursor: 'pointer' }} title="Devices held by this person">🤝 {heldCount[s.id]}</button>
                )}
                {canManage && (
                  <>
                    <button onClick={() => setForm({ id: s.id, name: s.name, number: s.number, role: s.role, stationIds: s.stationIds || [], canMove: s.canMove !== false, canCheckpoint: !!s.canCheckpoint, alertsOn: s.alertsOn !== false })} style={iconBtn}>✏️</button>
                    <button onClick={() => remove(s)} style={iconBtn}>🗑️</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {form && (
        <Modal title={form.id ? 'Edit staff' : 'Add staff'} onClose={() => { setForm(null); setStq(''); }}>
          <div style={fieldCol}>
            <div style={{ display: 'flex', gap: 8 }}>
              <Field label="Staff number"><input style={input} value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} placeholder="e.g. 101" /></Field>
              <Field label="Name"><input style={input} value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Jane Doe" /></Field>
            </div>
            <Field label="Role (optional)"><input style={input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} placeholder="e.g. Liaison, Warehouse" /></Field>
            <div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Assigned stations (optional — pick any)</div>
              {/* Long station lists get a filter; picked chips ALWAYS stay
                  visible so a filtered view can still unpick them. */}
              {stations.length > 8 && (
                <input value={stq} onChange={(e) => setStq(e.target.value)} placeholder={`🔎 Filter ${stations.length} stations…`} aria-label="Filter stations" style={{ ...input, minHeight: 38, marginBottom: 6 }} />
              )}
              {stations.length === 0 ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>No stations yet.</div> : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
                  {stations.filter((s) => form.stationIds.includes(s.id) || !stq.trim() || `${s.name} ${s.kind}`.toLowerCase().includes(stq.trim().toLowerCase())).map((s) => (
                    <Chip key={s.id} on={form.stationIds.includes(s.id)} onClick={() => toggleStation(s.id)}>{KIND_ICON[s.kind] || '📍'} {s.name}</Chip>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Portal permissions</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <Chip on={form.canMove !== false} onClick={() => setForm({ ...form, canMove: form.canMove === false })}>🔀 Can move devices</Chip>
                <Chip on={!!form.canCheckpoint} onClick={() => setForm({ ...form, canCheckpoint: !form.canCheckpoint })}>✅ Can do checkpoints</Chip>
                <Chip on={form.alertsOn !== false} onClick={() => setForm({ ...form, alertsOn: form.alertsOn === false })}>🔔 Station alerts</Chip>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>Everyone can log issues. Move &amp; Checkpoint appear in their portal only if enabled here.</div>
            </div>
          </div>
          <div style={modalActions}>
            <button onClick={() => setForm(null)} style={ghostBtn}>Cancel</button>
            <button onClick={save} disabled={!form.name.trim() && !form.number.trim()} style={primaryBtn}>Save</button>
          </div>
        </Modal>
      )}
      {heldFor && (
        <HeldDevicesModal
          suiteId={suiteId}
          staffId={heldFor.id}
          label={`${heldFor.number ? `#${heldFor.number} ` : ''}${heldFor.name || 'Staff'}`}
          reloadKey={reloadKey}
          onClose={() => setHeldFor(null)}
          onDevice={(d) => { setHeldFor(null); onDevice?.(d); }}
        />
      )}
    </div>
  );
}

// The shareable staff-portal link (token-gated). Staff open it, log in by number, and scan.
function StaffPortalCard({ suiteId, flash }) {
  const [kiosk, setKiosk] = useState(null);
  const [editing, setEditing] = useState(false);
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.eventopsKiosk(suiteId).then(setKiosk).catch(() => setKiosk({ error: true })); }, [suiteId]);
  if (!kiosk || kiosk.error) return null;
  const url = `${window.location.origin}${kiosk.path}`;
  const base = `${window.location.origin}/eventops/portal/${suiteId}/`;
  const copy = () => { try { navigator.clipboard.writeText(url); flash('Portal link copied'); } catch { /* ignore */ } };
  async function rotate() {
    if (!confirm('Generate a new random link? The current one will stop working immediately.')) return;
    try { setKiosk(await api.eventopsRotateKiosk(suiteId)); flash('New link generated'); } catch (e) { alert(e.message); }
  }
  async function toggle() {
    try { setKiosk(await api.eventopsSetKiosk(suiteId, !kiosk.enabled)); } catch (e) { alert(e.message); }
  }
  function startEdit() { setSlug(kiosk.token); setEditing(true); }
  async function saveSlug() {
    setBusy(true);
    try { const k = await api.eventopsSetKioskSlug(suiteId, slug); setKiosk(k); setEditing(false); flash('Link updated'); }
    catch (e) { alert(e.message); }
    setBusy(false);
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
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--muted)', wordBreak: 'break-all' }}>{base}</span>
            <input value={slug} autoFocus onChange={(e) => setSlug(e.target.value)} placeholder="e.g. summer-fest-2026"
              style={{ ...input, flex: 1, minWidth: 140, fontSize: 13 }} onKeyDown={(e) => e.key === 'Enter' && saveSlug()} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>Letters, numbers &amp; hyphens. Changing it stops the old link working.</div>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => setEditing(false)} style={ghostBtn}>Cancel</button>
            <button onClick={saveSlug} disabled={busy || slug.trim().length < 3} style={primaryBtn}>{busy ? 'Saving…' : 'Save link'}</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input readOnly value={url} style={{ ...input, flex: 1, minWidth: 180, fontSize: 12.5, opacity: kiosk.enabled ? 1 : 0.5 }} onFocus={(e) => e.target.select()} />
          <button onClick={copy} style={primaryBtn}>Copy</button>
          <button onClick={startEdit} style={ghostBtn}>Edit link</button>
          <button onClick={rotate} style={ghostBtn}>Randomise</button>
        </div>
      )}
    </div>
  );
}

// Drill-down: a right-hand drawer with the devices currently AT a station + its open issues.
function StationDevicesModal({ suiteId, station, reloadKey, onClose, onDevice }) {
  const [devices, setDevices] = useState(null);
  const [issues, setIssues] = useState(null);
  useEffect(() => {
    api.eventopsDevices(suiteId)
      .then((r) => setDevices((r.devices || []).filter((d) => d.stationId === station.id)))
      .catch(() => setDevices([]));
    api.eventopsIssues(suiteId, 'open')
      .then((r) => setIssues((r.issues || []).filter((i) => i.device?.stationId === station.id)))
      .catch(() => setIssues([]));
  }, [suiteId, station.id, reloadKey]);
  return (
    <Drawer title={station.name} subtitle={`${KIND_ICON[station.kind] || '📍'} ${station.kind}`} onClose={onClose}>
      <div style={sectionLabel}>Devices here ({devices?.length ?? '…'})</div>
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
      <div style={{ ...sectionLabel, marginTop: 18 }}>Open issues ({issues?.length ?? '…'})</div>
      {issues === null ? <Loading /> : issues.length === 0 ? <Empty>No open issues here.</Empty> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {issues.map((i) => (
            <div key={i.id} style={card}>
              <div style={{ fontWeight: 650, fontSize: 14 }}>{i.device?.label || i.device?.qrCode || 'Device'} · <span style={{ color: 'var(--error)' }}>{catLabel(i.category)}</span></div>
              {i.note && <div style={{ fontSize: 13, marginTop: 2 }}>{i.note}</div>}
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{i.staffLabel ? `${i.staffLabel} · ` : ''}⏱ {dur(i.reportedAt)}</div>
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}

// Drill-down: the devices a staff member is currently holding (optionally only those not
// placed at a station). Used from the Live "With staff" grouping and the staff record.
function HeldDevicesModal({ suiteId, staffId, label, noStationOnly, reloadKey, onClose, onDevice }) {
  const [devices, setDevices] = useState(null);
  useEffect(() => {
    api.eventopsDevices(suiteId)
      .then((r) => setDevices((r.devices || []).filter((d) => d.holderStaffId === staffId && (!noStationOnly || !d.stationId))))
      .catch(() => setDevices([]));
  }, [suiteId, staffId, noStationOnly, reloadKey]);
  return (
    <Drawer title={`🤝 ${label}`} subtitle="Devices in their hands" onClose={onClose}>
      <div style={sectionLabel}>Held ({devices?.length ?? '…'})</div>
      {devices === null ? <Loading /> : devices.length === 0 ? <Empty>No devices held right now.</Empty> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {devices.map((d) => (
            <button key={d.id} onClick={() => onDevice(d)} style={deviceRow(true)}>
              <div style={{ textAlign: 'left', minWidth: 0 }}>
                <div style={{ fontWeight: 650, fontSize: 14 }}>{d.label || d.qrCode || 'Device'}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{titleCase(d.type)} · {d.stationName ? `📍 ${d.stationName}` : 'no station'}</div>
              </div>
              <span style={{ fontSize: 12, color: 'var(--brand)', fontWeight: 700, whiteSpace: 'nowrap' }}>Move ›</span>
            </button>
          ))}
        </div>
      )}
    </Drawer>
  );
}

// A right-hand slide-over drawer (full-height) — used for the station drill-down.
function Drawer({ title, subtitle, onClose, children }) {
  return (
    <div style={drawerOverlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={drawerPanel}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <strong style={{ fontSize: 17 }}>{title}</strong>
            {subtitle && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} style={iconBtn} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ──────────────────────────────── Activity tab ────────────────────────────────
function ActivityTab({ suiteId, reloadKey }) {
  const [acts, setActs] = useState(null);
  const [summary, setSummary] = useState(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const load = () => { setActs(null); api.eventopsActivity(suiteId, { from, to, limit: 500 }).then((r) => { setActs(r.activity || []); setSummary(r.summary || null); }).catch(() => { setActs([]); setSummary(null); }); };
  useEffect(() => { load(); }, [suiteId, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const preset = (days) => { const now = new Date(); const f = new Date(now.getTime() - days * 86400000); setFrom(f.toISOString().slice(0, 10)); setTo(now.toISOString().slice(0, 10)); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>Report by period</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ fontSize: 12, color: 'var(--muted)' }}>From<br /><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ ...input, padding: '8px 10px' }} /></label>
          <label style={{ fontSize: 12, color: 'var(--muted)' }}>To<br /><input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ ...input, padding: '8px 10px' }} /></label>
          <button onClick={load} style={primaryBtn}>Apply</button>
          {(from || to) && <button onClick={() => { setFrom(''); setTo(''); setTimeout(load, 0); }} style={ghostBtn}>Clear</button>}
          <div style={{ display: 'flex', gap: 6 }}>
            {[['24h', 1], ['7d', 7], ['30d', 30]].map(([l, d]) => <Chip key={l} on={false} onClick={() => { preset(d); setTimeout(load, 0); }}>{l}</Chip>)}
          </div>
        </div>
        {summary && (
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13 }}>
            <span><b>{summary.total}</b> events</span>
            <span style={{ color: 'var(--muted)' }}>{summary.move || 0} moves</span>
            <span style={{ color: 'var(--muted)' }}>{summary.check || 0} issues/checks</span>
            <span style={{ color: 'var(--muted)' }}>{summary.status || 0} status changes</span>
            <span style={{ color: 'var(--muted)' }}>{summary.create || 0} added</span>
          </div>
        )}
      </div>
      {acts === null ? <Loading /> : acts.length === 0 ? <Empty>No activity in this period.</Empty> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {acts.map((e) => (
            <div key={e.id} style={feedRow}>
              <span style={{ fontSize: 13 }}>{e.device ? `${e.device.label || e.device.qrCode} · ` : ''}{feedText(e)}</span>
              <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{timeAgo(e.at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────── Checks tab ──────────────────────────────────
// Setup the named checkpoints + view the submissions (with photos) staff send from the portal.
function ChecksTab({ suiteId, canManage, flash, reloadKey }) {
  const [checkpoints, setCheckpoints] = useState(null);
  const [logs, setLogs] = useState(null);
  const [newName, setNewName] = useState('');
  const [photo, setPhoto] = useState(null);
  const [stationF, setStationF] = useState('all');
  const [staffF, setStaffF] = useState('all');
  const [stations, setStations] = useState([]);
  const [staff, setStaff] = useState([]);
  const load = () => {
    api.eventopsCheckpoints(suiteId).then((r) => setCheckpoints(r.checkpoints || [])).catch(() => setCheckpoints([]));
    api.eventopsCheckpointLogs(suiteId).then((r) => setLogs(r.logs || [])).catch(() => setLogs([]));
    api.eventopsStations(suiteId).then((r) => setStations(r.stations || [])).catch(() => {});
    api.eventopsStaff(suiteId).then((r) => setStaff(r.staff || [])).catch(() => {});
  };
  useEffect(() => { setCheckpoints(null); setLogs(null); load(); }, [suiteId, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Coverage: who/where has submitted a checkpoint vs still missing.
  const coverage = useMemo(() => {
    const lastByStation = {}; const staffDone = new Set();
    for (const l of logs || []) {
      if (l.stationLabel && (!lastByStation[l.stationLabel] || l.at > lastByStation[l.stationLabel])) lastByStation[l.stationLabel] = l.at;
      if (l.staffLabel) staffDone.add(l.staffLabel);
    }
    const stationRows = stations.map((s) => ({ name: s.name, last: lastByStation[s.name] || null }));
    const staffLabel = (s) => [s.number ? `#${s.number}` : '', s.name].filter(Boolean).join(' ').trim();
    const staffRows = staff.map((s) => ({ name: s.name || s.number, done: staffDone.has(staffLabel(s)) }));
    return { stationRows, staffRows };
  }, [logs, stations, staff]);

  async function add() { const name = newName.trim(); if (!name) return; try { await api.eventopsCreateCheckpoint(suiteId, name); setNewName(''); load(); flash('Checkpoint added'); } catch (e) { alert(e.message); } }
  async function rename(c) { const name = prompt('Rename checkpoint', c.name); if (name == null) return; try { await api.eventopsUpdateCheckpoint(suiteId, c.id, name); load(); } catch (e) { alert(e.message); } }
  async function del(c) { if (!confirm(`Delete “${c.name}”? Past submissions keep the name.`)) return; try { await api.eventopsDeleteCheckpoint(suiteId, c.id); load(); } catch (e) { alert(e.message); } }

  if (checkpoints === null || logs === null) return <Loading />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {(coverage.stationRows.length > 0 || coverage.staffRows.length > 0) && (
        <div style={card}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Coverage — checked in vs missing</div>
          {coverage.stationRows.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>STATIONS ({coverage.stationRows.filter((s) => s.last).length}/{coverage.stationRows.length})</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {coverage.stationRows.map((s) => (
                  <span key={s.name} style={{ ...chipStatic, borderColor: s.last ? 'var(--success)' : 'var(--error)', color: s.last ? 'var(--text)' : 'var(--error)' }}>
                    {s.last ? '✅' : '⭕'} {s.name}{s.last ? ` · ${timeAgo(s.last)}` : ' · missing'}
                  </span>
                ))}
              </div>
            </div>
          )}
          {coverage.staffRows.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>STAFF ({coverage.staffRows.filter((s) => s.done).length}/{coverage.staffRows.length})</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {coverage.staffRows.map((s) => (
                  <span key={s.name} style={{ ...chipStatic, borderColor: s.done ? 'var(--success)' : 'var(--border)', color: s.done ? 'var(--text)' : 'var(--muted)' }}>{s.done ? '✅' : '⭕'} {s.name}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {canManage && (
        <div style={card}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>Checkpoint types</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10 }}>Named checks staff complete at a station from the scan portal (e.g. Opening, Mid-shift, Closing).</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <input style={input} value={newName} placeholder="e.g. Opening check" onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
            <button onClick={add} style={primaryBtn}>Add</button>
          </div>
          {checkpoints.length === 0 ? <Empty>No checkpoint types yet.</Empty> : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {checkpoints.map((c) => (
                <span key={c.id} style={chipStatic}>✅ {c.name}
                  <button onClick={() => rename(c)} style={miniIcon}>✏️</button>
                  <button onClick={() => del(c)} style={miniIcon}>🗑️</button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <Section title={`Checkpoint log (${logs.length})`}>
        {logs.length === 0 ? <Empty>No checkpoints submitted yet — staff complete these from the scan portal.</Empty> : (() => {
          const stationNames = [...new Set(logs.map((l) => l.stationLabel).filter(Boolean))].sort();
          const staffNames = [...new Set(logs.map((l) => l.staffLabel).filter(Boolean))].sort();
          const shown = logs.filter((l) => (stationF === 'all' || l.stationLabel === stationF) && (staffF === 'all' || l.staffLabel === staffF));
          return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {stationNames.length > 1 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', alignSelf: 'center' }}>STATION</span>
                <Chip on={stationF === 'all'} onClick={() => setStationF('all')}>All</Chip>
                {stationNames.map((n) => <Chip key={n} on={stationF === n} onClick={() => setStationF(n)}>📍 {n}</Chip>)}
              </div>
            )}
            {staffNames.length > 1 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', alignSelf: 'center' }}>STAFF</span>
                <Chip on={staffF === 'all'} onClick={() => setStaffF('all')}>All</Chip>
                {staffNames.map((n) => <Chip key={n} on={staffF === n} onClick={() => setStaffF(n)}>{n}</Chip>)}
              </div>
            )}
            {shown.length === 0 ? <Empty>No checkpoints match this filter.</Empty> : shown.map((l) => (
              <div key={l.id} style={card}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  {l.photo && <img src={l.photo} alt="" onClick={() => setPhoto(l.photo)} style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, cursor: 'pointer', flexShrink: 0 }} />}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 650, fontSize: 14 }}>{l.checkpointName || 'Checkpoint'}{l.stationLabel ? ` · 📍 ${l.stationLabel}` : ''}</div>
                    {l.comment && <div style={{ fontSize: 13, marginTop: 2 }}>{l.comment}</div>}
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{l.staffLabel ? `${l.staffLabel} · ` : ''}{timeAgo(l.at)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          );
        })()}
      </Section>
      {photo && <div style={overlay} onClick={() => setPhoto(null)}><img src={photo} alt="" style={{ maxWidth: '92vw', maxHeight: '88vh', borderRadius: 12 }} /></div>}
    </div>
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
const leftNav = { display: 'flex', flexDirection: 'column', gap: 3, padding: 6, borderRadius: 14, border: '1px solid var(--hairline)', background: 'var(--card)' };
const navScan = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '13px', borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 16, fontWeight: 800, background: 'var(--brand)', color: '#fff', boxShadow: 'var(--shadow-sm)' };
const navMove = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px', borderRadius: 12, border: '1px solid var(--border)', cursor: 'pointer', fontSize: 15, fontWeight: 700, background: 'var(--card)', color: 'var(--text)' };
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
const mapCanvas = { position: 'relative', width: '100%', borderRadius: 14, border: '1px solid var(--hairline)', background: 'repeating-linear-gradient(0deg, var(--card), var(--card) 23px, var(--hairline) 24px), repeating-linear-gradient(90deg, var(--card), var(--card) 23px, var(--hairline) 24px)', overflow: 'hidden', touchAction: 'none' };
const mapPin = { position: 'absolute', transform: 'translate(-50%, -50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '8px 10px', borderRadius: 12, border: '2px solid var(--border)', background: 'var(--card)', color: 'var(--text)', boxShadow: 'var(--shadow-sm)', userSelect: 'none', touchAction: 'none' };
const mapPinCount = { marginTop: 3, minWidth: 22, padding: '1px 7px', borderRadius: 10, background: 'var(--brand)', color: '#fff', fontSize: 12, fontWeight: 800 };
const mapPinIssue = { position: 'absolute', top: -9, right: -9, padding: '1px 6px', borderRadius: 10, background: 'var(--error)', color: '#fff', fontSize: 11, fontWeight: 800, boxShadow: 'var(--shadow-sm)' };
const pinCtrls = { position: 'absolute', top: 'calc(100% + 4px)', left: '50%', marginLeft: -46, display: 'flex', gap: 3, padding: 3, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--card)', boxShadow: 'var(--shadow-sm)' };
const pinCtrlBtn = { width: 22, height: 22, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0 };
const chipStatic ={ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 20, border: '1px solid var(--border)', background: 'var(--card)', fontSize: 13, fontWeight: 600 };
const miniIcon = { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 };
const sectionLabel = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--muted)', margin: '0 0 8px' };
const drawerOverlay = { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'flex-end' };
const drawerPanel = { width: 'min(440px, 92vw)', height: '100%', overflowY: 'auto', background: 'var(--card)', padding: 18, boxShadow: 'var(--shadow-pop)' };
const overlay = { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const modalSheet = { width: '100%', maxWidth: 460, maxHeight: '88vh', overflowY: 'auto', background: 'var(--card)', borderRadius: 18, padding: 18, boxShadow: 'var(--shadow-pop)' };
const modalActions = { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 };
const toastStyle = { position: 'fixed', left: '50%', bottom: 90, transform: 'translateX(-50%)', zIndex: 1100, background: 'var(--text)', color: 'var(--bg)', padding: '10px 18px', borderRadius: 24, fontSize: 14, fontWeight: 600, boxShadow: 'var(--shadow-pop)' };
