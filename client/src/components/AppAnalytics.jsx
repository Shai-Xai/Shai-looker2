import { useEffect, useMemo, useState, useCallback } from 'react';
import ReactECharts from 'echarts-for-react/lib/core';
import echarts from '../lib/echarts.js';
import { brandPrimary } from '../lib/brand.js';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// 📱 App analytics — the UI over server/posthog.js (direct PostHog integration).
// Three exports:
//   PosthogSettingsCard — the platform connection card (Admin → Integrations)
//   AppAnalyticsAdmin   — the management tab (whole app, every client) with the
//                         event-mapping editor + app-user profiles
//   AppAnalyticsPanel   — the client-scoped view (scope 'my' | 'admin-client'),
//                         used by the client's App page and the admin lens
// Uninstall with server/posthog.js — see that file's header.

const fmt = (n) => (n == null ? '—' : Intl.NumberFormat('en-ZA', { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n));
const DAY_CHOICES = [7, 28, 90];
const HOURLY_MAX_DAYS = 14; // matches the server cap

// ── window state: an inclusive {from,to} date range + a day/hour granularity ────
const isoDay = (offset = 0) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
const presetRange = (days) => ({ from: isoDay(-(days - 1)), to: isoDay(0) });
const rangeDays = (r) => Math.round((Date.parse(r.to) - Date.parse(r.from)) / 86400_000) + 1;
const clampHourly = (r) => (rangeDays(r) > HOURLY_MAX_DAYS
  ? { from: new Date(Date.parse(r.to) - (HOURLY_MAX_DAYS - 1) * 86400_000).toISOString().slice(0, 10), to: r.to }
  : r);

// Daily/Hourly toggle + from/to date pickers + quick presets. Hourly ranges are
// clamped to the server's 14-day cap (hour-points beyond that are noise).
function WindowControls({ gran, setGran, range, setRange }) {
  const apply = (next, g = gran) => {
    if (next.from > next.to) next = { from: next.to, to: next.from };
    setRange(g === 'hour' ? clampHourly(next) : next);
  };
  const pick = (g) => { setGran(g); if (g === 'hour') setRange(clampHourly(range)); };
  return (
    <>
      <Chip on={gran === 'day'} onClick={() => pick('day')}>Daily</Chip>
      <Chip on={gran === 'hour'} onClick={() => pick('hour')}>Hourly</Chip>
      <input type="date" style={dateInput} value={range.from} max={isoDay(0)} onChange={(e) => e.target.value && apply({ ...range, from: e.target.value })} aria-label="From date" />
      <span style={{ color: 'var(--muted)', fontSize: 12 }}>→</span>
      <input type="date" style={dateInput} value={range.to} max={isoDay(0)} onChange={(e) => e.target.value && apply({ ...range, to: e.target.value })} aria-label="To date" />
      <Chip on={range.from === isoDay(0) && range.to === isoDay(0)} onClick={() => { setGran('hour'); apply({ from: isoDay(0), to: isoDay(0) }, 'hour'); }}>Today</Chip>
      {DAY_CHOICES.map((d) => (
        <Chip key={d} on={range.from === presetRange(d).from && range.to === isoDay(0)}
          onClick={() => { if (d > HOURLY_MAX_DAYS && gran === 'hour') setGran('day'); apply(presetRange(d), d > HOURLY_MAX_DAYS ? 'day' : gran); }}>{d}d</Chip>
      ))}
    </>
  );
}

// ── Connection card (platform-level; key is write-only) ─────────────────────────
export function PosthogSettingsCard() {
  const [v, setV] = useState(null);
  const [host, setHost] = useState('');
  const [projectId, setProjectId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [eventIdProp, setEventIdProp] = useState('');
  const [eventNameProp, setEventNameProp] = useState('');
  const [saved, setSaved] = useState(false);
  const [testState, setTestState] = useState('');
  const load = useCallback(() => api.posthogSettings().then((s) => {
    setV(s); setHost(s.host || ''); setProjectId(s.projectId || '');
    setEventIdProp(s.eventIdProp || ''); setEventNameProp(s.eventNameProp || '');
  }).catch(() => setV(null)), []);
  useEffect(() => { load(); }, [load]);
  if (!v) return null;

  const save = async () => {
    const p = { host, projectId, eventIdProp, eventNameProp };
    if (apiKey) p.apiKey = apiKey;
    if (clearKey) p.clearApiKey = true;
    await api.savePosthogSettings(p);
    setApiKey(''); setClearKey(false); setSaved(true); setTimeout(() => setSaved(false), 1600);
    load();
  };
  return (
    <div style={card}>
      <div style={title}>📱 PostHog — app analytics</div>
      <p style={sub}>Howler's app analytics, straight from <a href="https://posthog.com" target="_blank" rel="noreferrer">PostHog</a>. One platform connection powers the App analytics tab and every client's App page (scoped by the <code>eventID</code> each app event carries). Use a <b>personal API key</b> with query-read access — project keys can't query.</p>
      <div style={grid2}>
        <label style={lbl}>Host
          <input style={input} value={host} onChange={(e) => setHost(e.target.value)} placeholder="https://eu.posthog.com" autoComplete="off" />
        </label>
        <label style={lbl}>Project ID
          <input style={input} value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="e.g. 12345" autoComplete="off" />
        </label>
      </div>
      <label style={lbl}>Personal API key
        <input style={input} type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={clearKey}
          placeholder={v.keySet ? `Set (${v.keyHint || '••••'}) — leave blank to keep` : v.envFallback ? 'Using the .env key — type to override' : 'phx_…'} />
      </label>
      {v.keySet && !v.envFallback && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--muted)', margin: '6px 0' }}>
          <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} /> Remove this key
        </label>
      )}
      <div style={grid2}>
        <label style={lbl}>Event-ID property
          <input style={input} value={eventIdProp} onChange={(e) => setEventIdProp(e.target.value)} placeholder="eventID" autoComplete="off" />
        </label>
        <label style={lbl}>Event-name property
          <input style={input} value={eventNameProp} onChange={(e) => setEventNameProp(e.target.value)} placeholder="eventName" autoComplete="off" />
        </label>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
        <button type="button" style={btn} onClick={save}>Save</button>
        {saved && <span style={okTxt}>✓ Saved</span>}
        <button type="button" style={ghostBtn} disabled={testState === '…'}
          onClick={async () => {
            setTestState('…');
            try { const r = await api.testPosthog(); setTestState(`✓ Connected — ${fmt(r.events24h)} events in the last 24h`); }
            catch (e) { setTestState(`✗ ${e.message}`); }
          }}>{testState === '…' ? 'Testing…' : 'Test connection'}</button>
        {testState && testState !== '…' && <span style={{ fontSize: 12.5, fontWeight: 600, color: testState.startsWith('✓') ? 'var(--success, #10b981)' : 'var(--danger, #dc2626)' }}>{testState}</span>}
      </div>
      {v.lastError && <p style={{ ...sub, color: 'var(--danger, #dc2626)', marginTop: 10 }}>Last sync error: {v.lastError}</p>}
    </div>
  );
}

// ── Management tab (Admin → 📱 App analytics) ───────────────────────────────────
export function AppAnalyticsAdmin() {
  const isMobile = useIsMobile();
  const [gran, setGran] = useState('day');
  const [range, setRange] = useState(() => presetRange(28));
  const [entityId, setEntityId] = useState('');
  const [clients, setClients] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const winKey = `${entityId || 'all'}-${range.from}-${range.to}`;
  useEffect(() => { api.adminListEntities().then((e) => setClients((e || []).map((x) => ({ id: x.id, name: x.name })))).catch(() => {}); }, []);
  const load = useCallback(() => {
    setError('');
    api.adminAppAnalytics({ from: range.from, to: range.to, entityId }).then(setData).catch((e) => { setError(e.message); setData(null); });
  }, [range.from, range.to, entityId]);
  useEffect(() => { load(); }, [load]);

  if (error && !data) return <div style={errBox}>{error}</div>;
  if (!data) return <div style={mutedTxt}>Loading…</div>;
  if (!data.configured) {
    return (
      <div style={card}>
        <div style={title}>📱 App analytics</div>
        <p style={sub}>Connect PostHog first — Integrations → <b>PostHog — app analytics</b> (host, project ID, personal API key). Once connected, the whole Howler app's engagement lands here and each client's App page lights up automatically.</p>
      </div>
    );
  }

  const perClient = !!entityId;
  const headline = data.headline || {};
  // Views / CTA taps / Purchases only earn a tile once the mapping gives them
  // data — an all-zero tile is noise, and they reappear by themselves after the
  // mapping + sync land.
  const stats = perClient
    ? [
        ['Viewers today', data.live?.actives, true],
        ['Unique viewers', data.totals?.uniques],
        ['Interactions', data.totals?.interactions],
        ...[['Views', data.totals?.views], ['CTA taps', data.totals?.ctaTaps], ['Purchases', data.totals?.purchases]].filter(([, v]) => v > 0),
      ]
    : [
        ['Active today', data.live?.actives, true],
        ['Weekly active', headline.wau],
        ['Monthly active', headline.mau],
        ['New users', data.totals?.newUsers],
        ['Sessions', data.totals?.sessions],
        ['Interactions', data.totals?.interactions],
      ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <select style={{ ...input, width: 'auto', minWidth: 160 }} value={entityId} onChange={(e) => setEntityId(e.target.value)}>
          <option value="">All clients — whole app</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <WindowControls gran={gran} setGran={setGran} range={range} setRange={setRange} />
        <button type="button" style={ghostBtn} disabled={syncing} onClick={async () => {
          setSyncing(true); setError(''); setSyncMsg('');
          try {
            const r = await api.syncAppAnalytics();
            setSyncMsg(r.eventRows > 0
              ? `✓ Synced — ${r.eventRows} event-day rows over ${r.days} days`
              : `⚠ Synced, but 0 events carried the event-ID property — run 🔬 Diagnose below to find the right property name`);
            load();
          } catch (e) { setError(e.message); }
          setSyncing(false);
        }}>{syncing ? 'Syncing…' : '↻ Sync now'}</button>
      </div>
      {syncMsg && <p style={{ fontSize: 12.5, fontWeight: 600, color: syncMsg.startsWith('✓') ? 'var(--success, #10b981)' : '#d97706', margin: '0 0 10px' }}>{syncMsg}</p>}
      {error && <div style={errBox}>{error}</div>}
      {data.liveError && <p style={{ ...mutedTxt, fontSize: 12 }}>{data.liveError}</p>}
      {perClient && data.scoped === false && (
        <div style={card}><p style={sub}>No Howler event ids resolve for this client yet — their suites need an event lock (name or id) before app data can be scoped to them.</p></div>
      )}

      <StatRow stats={stats} isMobile={isMobile} />
      {gran === 'hour' ? (
        <TodayChart key={`hourly-${winKey}`} loader={() => api.adminAppToday({ entityId, from: range.from, to: range.to })} />
      ) : (
      <SeriesCard
        series={data.series || []}
        metrics={perClient
          ? [['uniques', 'Unique viewers'], ['interactions', 'Interactions'],
              ...[['views', 'Views', data.totals?.views], ['ctaTaps', 'CTA taps', data.totals?.ctaTaps], ['purchases', 'Purchases', data.totals?.purchases]].filter(([, , v]) => v > 0).map(([k, l]) => [k, l])]
          : [['dau', 'Active users'], ['views', 'Views'], ['interactions', 'Interactions'], ['new_users', 'New users'], ['sessions', 'Sessions']]}
        isMobile={isMobile}
      />
      )}
      <EventsTable rows={perClient ? data.events : data.topEvents} title={perClient ? 'Their events in the app' : 'Top events by in-app attention'} days={data.days} />
      <BreakdownsCard key={`bd-${winKey}`} keys={data.breakdowns || []}
        loader={(key) => api.adminAppBreakdown({ key, from: range.from, to: range.to, entityId })}
        seriesLoader={(key) => api.adminAppBreakdownSeries({ key, from: range.from, to: range.to, entityId })} />
      <TopUsersCard key={`top-${winKey}`} loader={(opts) => api.adminAppPeople({ ...opts, from: range.from, to: range.to, entityId })} />
      <PeopleSection key={`ppl-${winKey}`} loader={(opts) => api.adminAppPeople({ ...opts, from: range.from, to: range.to, entityId })} />
      {!perClient && <MappingEditor />}
      {!perClient && <DiagnoseCard />}
      {data.lastSync && <p style={{ ...mutedTxt, fontSize: 11.5, marginTop: 10 }}>Rollup last synced {new Date(data.lastSync).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · live numbers refresh on load (≤5 min cache)</p>}
    </div>
  );
}

// ── Client-scoped panel (their events only; also the admin per-client lens) ─────
export function AppAnalyticsPanel({ entityId, scope = 'my' }) {
  const isMobile = useIsMobile();
  const [gran, setGran] = useState('day');
  const [range, setRange] = useState(() => presetRange(28));
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const winKey = `${entityId}-${range.from}-${range.to}`;
  useEffect(() => {
    if (!entityId) return;
    setError('');
    const w = { from: range.from, to: range.to };
    const req = scope === 'admin-client' ? api.adminAppAnalytics({ ...w, entityId }) : api.myAppAnalytics(entityId, w);
    req.then(setData).catch((e) => { setError(e.message); setData(null); });
  }, [entityId, scope, range.from, range.to]);

  if (error) return <div style={errBox}>{error}</div>;
  if (!data) return <div style={mutedTxt}>Loading…</div>;
  if (!data.configured || !data.scoped) {
    if (scope !== 'admin-client' && !data.configured) return null; // nothing to say to a client pre-connection
    return (
      <div style={card}>
        <div style={title}>📲 Your events in the Howler app</div>
        <p style={sub}>{!data.configured
          ? 'PostHog isn\'t connected yet (Admin → Integrations) — app engagement appears here once it is.'
          : 'No app data can be scoped to this client yet — their suites need an event lock so Pulse knows which Howler events are theirs.'}</p>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ flex: 1, fontSize: 12.5, color: 'var(--muted)' }}>How your events perform inside the Howler app.</span>
        <WindowControls gran={gran} setGran={setGran} range={range} setRange={setRange} />
      </div>
      {data.liveError && <p style={{ ...mutedTxt, fontSize: 12 }}>{data.liveError}</p>}
      <StatRow isMobile={isMobile} stats={[
        ['Viewers today', data.live?.actives, true],
        ['Unique viewers', data.live?.windowUniques ?? data.totals?.uniques, data.live?.windowUniques != null],
        ['Interactions', data.totals?.interactions],
        // unmapped/empty metrics stay hidden until they have data (see AppAnalyticsAdmin)
        ...[['Views', data.totals?.views], ['CTA taps', data.totals?.ctaTaps], ['Purchases', data.totals?.purchases]].filter(([, v]) => v > 0),
      ]} />
      {gran === 'hour' ? (
        <TodayChart key={`hourly-${winKey}`} loader={() => (scope === 'admin-client' ? api.adminAppToday({ entityId, from: range.from, to: range.to }) : api.myAppToday(entityId, { from: range.from, to: range.to }))} />
      ) : (
      <SeriesCard series={data.series || []} isMobile={isMobile}
        metrics={[['uniques', 'Unique viewers'], ['interactions', 'Interactions'],
          ...[['views', 'Views', data.totals?.views], ['ctaTaps', 'CTA taps', data.totals?.ctaTaps], ['purchases', 'Purchases', data.totals?.purchases]].filter(([, , v]) => v > 0).map(([k, l]) => [k, l])]} />
      )}
      <EventsTable rows={data.events} title="By event" days={data.days} />
      <BreakdownsCard key={`bd-${winKey}`} keys={data.breakdowns || []}
        loader={(key) => (scope === 'admin-client' ? api.adminAppBreakdown({ key, from: range.from, to: range.to, entityId }) : api.myAppBreakdown(entityId, { key, from: range.from, to: range.to }))}
        seriesLoader={(key) => (scope === 'admin-client' ? api.adminAppBreakdownSeries({ key, from: range.from, to: range.to, entityId }) : api.myAppBreakdownSeries(entityId, { key, from: range.from, to: range.to }))} />
      <TopUsersCard key={`top-${winKey}`}
        loader={(opts) => (scope === 'admin-client' ? api.adminAppPeople({ ...opts, from: range.from, to: range.to, entityId }) : api.myAppPeople(entityId, { ...opts, from: range.from, to: range.to }))} />
      <PeopleSection key={`ppl-${winKey}`}
        loader={(opts) => (scope === 'admin-client' ? api.adminAppPeople({ ...opts, from: range.from, to: range.to, entityId }) : api.myAppPeople(entityId, { ...opts, from: range.from, to: range.to }))} />
    </div>
  );
}

// ── shared pieces ────────────────────────────────────────────────────────────────
function StatRow({ stats, isMobile }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${isMobile ? 130 : 150}px, 1fr))`, gap: 8, marginBottom: 12 }}>
      {stats.map(([label, v, live]) => (
        <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: '11px 13px' }}>
          <div style={{ fontSize: 22, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{fmt(v)}</div>
          <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginTop: 2 }}>
            {label}{live && v != null && <span style={{ color: 'var(--success, #10b981)' }}> · live</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

// One recessive line chart; chips pick WHICH single series shows (one axis, no
// dual scales). `series` rows are the rollup rows keyed by `date`.
function SeriesCard({ series, metrics, isMobile }) {
  const [metric, setMetric] = useState(metrics[0][0]);
  const option = useMemo(() => {
    const brand = brandPrimary();
    return {
      animationDuration: 300,
      grid: { left: 8, right: 12, top: 12, bottom: 8, containLabel: true },
      tooltip: { trigger: 'axis', valueFormatter: (v) => (v == null ? '—' : Number(v).toLocaleString('en-ZA')) },
      xAxis: { type: 'time', axisLine: { lineStyle: { color: 'rgba(128,128,128,0.25)' } }, axisLabel: { color: 'var(--muted, #888)', fontSize: 10.5, hideOverlap: true }, splitLine: { show: false } },
      yAxis: { type: 'value', axisLabel: { color: 'var(--muted, #888)', fontSize: 10.5, formatter: (v) => fmt(v) }, splitLine: { lineStyle: { color: 'rgba(128,128,128,0.12)' } } },
      series: [{
        type: 'line', showSymbol: false, smooth: 0.15,
        lineStyle: { width: 2, color: brand },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: `${brand}45` }, { offset: 1, color: `${brand}05` }]) },
        data: series.map((r) => [r.date, r[metric] == null ? 0 : r[metric]]),
      }],
    };
  }, [series, metric]);
  return (
    <div style={{ ...card, marginTop: 0 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {metrics.map(([k, label]) => <Chip key={k} on={metric === k} onClick={() => setMetric(k)}>{label}</Chip>)}
      </div>
      {series.length === 0
        ? <p style={sub}>No rollup data yet — run a sync (or wait for tonight's).</p>
        : <ReactECharts echarts={echarts} option={option} notMerge style={{ height: isMobile ? 200 : 260, width: '100%' }} opts={{ renderer: 'canvas' }} />}
    </div>
  );
}

// Today, hour by hour — live from PostHog (same 4-min cache). Swaps in for the
// daily SeriesCard when the "Today" chip is active; same one-metric-at-a-time
// chips, zero/unmapped metrics hidden.
function TodayChart({ loader }) {
  const isMobile = useIsMobile();
  const [out, setOut] = useState(null);
  const [error, setError] = useState('');
  const [metric, setMetric] = useState('uniques');
  useEffect(() => {
    let dead = false;
    loader().then((r) => { if (!dead) setOut(r); }).catch((e) => { if (!dead) setError(e.message); });
    return () => { dead = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- loader is stable per mount (card is keyed by scope)
  const hours = out?.hours || [];
  const totals = { uniques: 0, interactions: 0, views: 0, ctaTaps: 0, purchases: 0 };
  for (const h of hours) { totals.interactions += h.interactions; totals.views += h.views; totals.ctaTaps += h.ctaTaps; totals.purchases += h.purchases; totals.uniques = Math.max(totals.uniques, h.uniques); }
  const metrics = [['uniques', 'Unique viewers'], ['interactions', 'Interactions'],
    ...[['views', 'Views', totals.views], ['ctaTaps', 'CTA taps', totals.ctaTaps], ['purchases', 'Purchases', totals.purchases]].filter(([, , v]) => v > 0).map(([k, l]) => [k, l])];
  const option = useMemo(() => {
    const brand = brandPrimary();
    return {
      animationDuration: 300,
      grid: { left: 8, right: 12, top: 12, bottom: 8, containLabel: true },
      tooltip: { trigger: 'axis', valueFormatter: (v) => (v == null ? '—' : Number(v).toLocaleString('en-ZA')) },
      xAxis: { type: 'category', data: hours.map((h) => String(h.hour).slice(11, 16) || String(h.hour)), axisLine: { lineStyle: { color: 'rgba(128,128,128,0.25)' } }, axisLabel: { color: 'var(--muted, #888)', fontSize: 10.5, hideOverlap: true }, splitLine: { show: false } },
      yAxis: { type: 'value', axisLabel: { color: 'var(--muted, #888)', fontSize: 10.5, formatter: (v) => fmt(v) }, splitLine: { lineStyle: { color: 'rgba(128,128,128,0.12)' } } },
      series: [{
        type: 'line', showSymbol: hours.length < 3, smooth: 0.15,
        lineStyle: { width: 2, color: brand }, itemStyle: { color: brand },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: `${brand}45` }, { offset: 1, color: `${brand}05` }]) },
        data: hours.map((h) => h[metric] == null ? 0 : h[metric]),
      }],
    };
  }, [out, metric]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={{ ...card, marginTop: 0 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {metrics.map(([k, label]) => <Chip key={k} on={metric === k} onClick={() => setMetric(k)}>{label}</Chip>)}
      </div>
      {error && <div style={errBox}>{error}</div>}
      {!out && !error && <p style={mutedTxt}>Loading…</p>}
      {out && hours.length === 0 && <p style={sub}>Nothing recorded yet today.</p>}
      {out && hours.length > 0 && (
        <>
          <ReactECharts echarts={echarts} option={option} notMerge style={{ height: isMobile ? 200 : 260, width: '100%' }} opts={{ renderer: 'canvas' }} />
          <p style={{ ...mutedTxt, fontSize: 11 }}>Hour by hour since midnight · live from PostHog (≤5 min cache). "Unique viewers" is unique people per hour.</p>
        </>
      )}
    </div>
  );
}

function EventsTable({ rows, title: heading, days }) {
  if (!rows || rows.length === 0) return null;
  // All-zero optional columns (unmapped metrics) stay hidden until they have data.
  const cols = [
    ['uniques', 'Uniques', true],
    ['views', 'Views', rows.some((r) => r.views > 0)],
    ['interactions', 'Interactions', true],
    ['ctaTaps', 'CTA taps', rows.some((r) => r.ctaTaps > 0)],
    ['purchases', 'Purchases', rows.some((r) => r.purchases > 0)],
  ].filter(([, , show]) => show);
  return (
    <div style={{ ...card, marginTop: 12, overflowX: 'auto' }}>
      <div style={title}>{heading}</div>
      <p style={sub}>Last {days} days · sorted by unique viewers</p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 420 }}>
        <thead><tr><th style={th}>Event</th>{cols.map(([k, h]) => <th key={k} style={th}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.eventRef}>
              <td style={{ ...td, fontWeight: 600 }}>{r.eventName || `Event ${r.eventRef}`}<span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {r.eventRef}</span></td>
              {cols.map(([k]) => (
                <td key={k} style={td}>{fmt(r[k])}{k === 'purchases' && r.purchaseValue > 0 && <span style={{ color: 'var(--muted)' }}> · {fmt(r.purchaseValue)}</span>}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Fixed per-value line colors — validated for CVD + contrast on BOTH light and
// dark surfaces (dataviz six-checks). Color follows the value's slot in the
// server's top-N order for this view, never re-painted by legend toggles.
const SERIES_COLORS = ['#ff385c', '#3b82f6', '#d97706', '#0d9488', '#8b5cf6', '#0891b2'];

// What's driving the numbers — top values of the configured breakdown properties
// (interaction_type / CTA_Label / surface), live-queried per chip with a short
// server-side cache, PLUS a per-value daily line chart (the legend is the
// filter — click a value to hide/show its line). Scoped exactly like the rest
// of the surface.
function BreakdownsCard({ keys, loader, seriesLoader }) {
  const [key, setKey] = useState(keys[0] || '');
  const [out, setOut] = useState(null);
  const [seriesOut, setSeriesOut] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!key) return;
    let dead = false;
    setBusy(true); setError(''); setSeriesOut(null);
    loader(key)
      .then((r) => { if (!dead) setOut(r); })
      .catch((e) => { if (!dead) { setError(e.message); setOut(null); } })
      .finally(() => { if (!dead) setBusy(false); });
    if (seriesLoader) seriesLoader(key).then((r) => { if (!dead) setSeriesOut(r); }).catch(() => { if (!dead) setSeriesOut(null); });
    return () => { dead = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- loaders are stable per mount (card is keyed by scope)
  if (!keys.length) return null;
  const max = Math.max(1, ...(out?.values || []).map((v) => v.count));
  return (
    <div style={{ ...card, marginTop: 12 }}>
      <div style={title}>🧩 What's driving it</div>
      <p style={sub}>The busiest values behind the interactions — pick a property. In the chart, click a value in the legend to hide or show its line.</p>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {keys.map((k) => <Chip key={k} on={key === k} onClick={() => setKey(k)}>{k}</Chip>)}
      </div>
      {error && <div style={errBox}>{error}</div>}
      {seriesOut && seriesOut.series?.length > 0 && <BreakdownSeriesChart data={seriesOut} />}
      {busy && <p style={mutedTxt}>Loading…</p>}
      {!busy && out && out.values.length === 0 && <p style={sub}>Nothing recorded for "{out.key}" in this window.</p>}
      {!busy && out && out.values.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 420 }}>
            <thead><tr>{[out.key, '', 'Count', 'Uniques'].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {out.values.map((v) => (
                <tr key={v.value}>
                  <td style={{ ...td, fontWeight: 600, whiteSpace: 'normal' }}>{v.value}</td>
                  <td style={{ ...td, width: '30%', minWidth: 90 }}><span style={{ display: 'inline-block', height: 8, borderRadius: 4, background: 'var(--brand)', opacity: 0.75, width: `${Math.max(3, Math.round((v.count / max) * 100))}%` }} /></td>
                  <td style={td}>{fmt(v.count)}</td>
                  <td style={td}>{fmt(v.uniques)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// One line per breakdown value over the window. ECharts' legend does the value
// filtering natively; colors are the validated fixed order (SERIES_COLORS).
function BreakdownSeriesChart({ data }) {
  const isMobile = useIsMobile();
  const option = useMemo(() => {
    const days = [...new Set(data.series.map((r) => r.day))].sort();
    const byValue = new Map(data.values.map((v) => [v, new Map()]));
    for (const r of data.series) byValue.get(r.value)?.set(r.day, r.count);
    return {
      animationDuration: 300,
      grid: { left: 8, right: 12, top: 34, bottom: 8, containLabel: true },
      legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 12, textStyle: { color: 'var(--muted, #888)', fontSize: 11 } },
      tooltip: { trigger: 'axis', valueFormatter: (v) => (v == null ? '—' : Number(v).toLocaleString('en-ZA')) },
      xAxis: { type: 'category', data: days, axisLine: { lineStyle: { color: 'rgba(128,128,128,0.25)' } }, axisLabel: { color: 'var(--muted, #888)', fontSize: 10.5, hideOverlap: true, formatter: (d) => String(d).slice(5) }, splitLine: { show: false } },
      yAxis: { type: 'value', axisLabel: { color: 'var(--muted, #888)', fontSize: 10.5, formatter: (v) => fmt(v) }, splitLine: { lineStyle: { color: 'rgba(128,128,128,0.12)' } } },
      series: data.values.map((v, i) => ({
        name: v, type: 'line', showSymbol: false, smooth: 0.15,
        lineStyle: { width: 2, color: SERIES_COLORS[i % SERIES_COLORS.length] },
        itemStyle: { color: SERIES_COLORS[i % SERIES_COLORS.length] },
        data: days.map((d) => byValue.get(v)?.get(d) ?? 0),
      })),
    };
  }, [data]);
  return (
    <div style={{ width: '100%', overflow: 'hidden', marginBottom: 12 }}>
      <ReactECharts echarts={echarts} option={option} notMerge style={{ height: isMobile ? 220 : 280, width: '100%' }} opts={{ renderer: 'canvas' }} />
    </div>
  );
}

// 🏆 Top users — the 10 most active people in the window, its own card (moved
// out of the App-users list per Shai). Auto-loads: it's a headline metric, and
// the server caches the query.
function TopUsersCard({ loader }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let dead = false;
    setRows(null); setError('');
    loader({ orderBy: 'active', limit: 10 })
      .then((r) => { if (!dead) setRows(r.people || []); })
      .catch((e) => { if (!dead) setError(e.message); });
    return () => { dead = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- loader is stable per mount (card is keyed by scope+window)
  if (rows && rows.length === 0) return null; // no signal, no card
  const max = Math.max(1, ...(rows || []).map((p) => p.interactions || 0));
  return (
    <div style={{ ...card, marginTop: 12 }}>
      <div style={title}>🏆 Top users</div>
      <p style={sub}>The 10 most active app users in this window, by interactions.</p>
      {error && <div style={errBox}>{error}</div>}
      {!rows && !error && <p style={mutedTxt}>Loading…</p>}
      {rows && rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 480 }}>
            <thead><tr>{['#', 'Name', 'Email', '', 'Interactions', 'Last seen'].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((p, i) => (
                <tr key={i}>
                  <td style={{ ...td, color: 'var(--muted)' }}>{i + 1}</td>
                  <td style={{ ...td, fontWeight: 600 }}>{[p.firstName, p.lastName].filter(Boolean).join(' ') || '—'}</td>
                  <td style={td}>{p.email || '—'}</td>
                  <td style={{ ...td, width: '24%', minWidth: 80 }}><span style={{ display: 'inline-block', height: 8, borderRadius: 4, background: 'var(--brand)', opacity: 0.75, width: `${Math.max(4, Math.round(((p.interactions || 0) / max) * 100))}%` }} /></td>
                  <td style={td}>{fmt(p.interactions)}</td>
                  <td style={td}>{p.lastSeen ? new Date(p.lastSeen).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// App-user profiles (PostHog person properties). Loaded on demand — live PostHog
// queries are scarce, so nothing fires until someone asks for the list.
function PeopleSection({ loader }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  // Fresh list (new search) or append the next page. Most-active ranking lives
  // in its own TopUsersCard — this list stays most-recent-first.
  const load = async (term, { append = false } = {}) => {
    setBusy(true); setError('');
    try {
      const r = await loader({ q: term, offset: append ? (rows?.length || 0) : 0 });
      setRows(append ? [...(rows || []), ...(r.people || [])] : (r.people || []));
      setHasMore(!!r.hasMore);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const exportCsv = () => {
    const head = ['First name', 'Surname', 'Email', 'Mobile', 'Last seen', 'Interactions', 'Events'];
    const csv = [head, ...(rows || []).map((p) => [p.firstName, p.lastName, p.email, p.phone, p.lastSeen, p.interactions, (p.eventNames || []).join('; ')])]
      .map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'app-users.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div style={{ ...card, marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ ...title, flex: 1, marginBottom: 0 }}>👤 App users</div>
        {rows && rows.length > 0 && <button type="button" style={ghostBtn} onClick={exportCsv}>Export CSV</button>}
      </div>
      <p style={sub}>Who's actually in the app — profile details (email, name, mobile) from PostHog, most recent first.</p>
      {!open ? (
        <button type="button" style={btn} onClick={() => { setOpen(true); load(''); }}>Load app users</button>
      ) : (
        <>
          <form style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); load(q); }}>
            <input style={{ ...input, flex: 1, minWidth: 180 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email or mobile…" />
            <button type="submit" style={ghostBtn} disabled={busy}>{busy ? '…' : 'Search'}</button>
          </form>
          {error && <div style={errBox}>{error}</div>}
          {busy && !rows && <p style={mutedTxt}>Loading…</p>}
          {rows && rows.length === 0 && <p style={sub}>No app users found in this window.</p>}
          {rows && rows.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 620 }}>
                <thead><tr>{['Name', 'Email', 'Mobile', 'Interactions', 'Last seen', 'Events'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {rows.map((p, i) => (
                    <tr key={i}>
                      <td style={{ ...td, fontWeight: 600 }}>{[p.firstName, p.lastName].filter(Boolean).join(' ') || '—'}</td>
                      <td style={td}>{p.email || '—'}</td>
                      <td style={td}>{p.phone || '—'}</td>
                      <td style={td}>{fmt(p.interactions)}</td>
                      <td style={td}>{p.lastSeen ? new Date(p.lastSeen).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                      <td style={{ ...td, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{(p.eventNames || []).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {rows && rows.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <span style={{ ...mutedTxt, fontSize: 12 }}>Showing {rows.length}{hasMore ? ' — more available' : ' (all in this window)'}</span>
              {hasMore && <button type="button" style={ghostBtn} disabled={busy} onClick={() => load(q, { append: true })}>{busy ? '…' : 'Load more'}</button>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Which PostHog events mean what (screens / CTAs / purchases / notifications) +
// the person-profile property names — with a live catalog of what the app sends.
function MappingEditor() {
  const [m, setM] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [catErr, setCatErr] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { api.posthogSettings().then((s) => setM(s.metricMap)).catch(() => {}); }, []);
  if (!m) return null;
  const listVal = (k) => (Array.isArray(m[k]) ? m[k].join('\n') : m[k] || '');
  const setList = (k, v) => setM({ ...m, [k]: v.split(/\n/) });
  const setPerson = (k, v) => setM({ ...m, personProps: { ...m.personProps, [k]: v } });
  const save = async () => {
    await api.savePosthogSettings({ metricMap: m });
    setSaved(true); setTimeout(() => setSaved(false), 1600);
  };
  return (
    <div style={{ ...card, marginTop: 12 }}>
      <div style={title}>🧭 Event mapping</div>
      <p style={sub}>Tell Pulse which PostHog events mean what — one entry per line. Either a plain event name, or <code>event : property=value</code> when one generic event carries several meanings (e.g. <code>interaction : interaction_type=event_view</code>). <code>property=*</code> means "the property is present with any value" (e.g. <code>interaction : CTA_Label=*</code> counts every labelled CTA tap). The catalog shows what the app actually sends, busiest first; 🔬 Diagnose shows the property keys and values.</p>
      <div style={grid2}>
        {[['screenEvents', 'Screen / page views'], ['ctaEvents', 'CTA taps'], ['purchaseEvents', 'Purchases'], ['notificationEvents', 'Notifications']].map(([k, label]) => (
          <label key={k} style={lbl}>{label}
            <textarea style={{ ...input, minHeight: 64, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} value={listVal(k)} onChange={(e) => setList(k, e.target.value)} />
          </label>
        ))}
      </div>
      <div style={grid2}>
        <label style={lbl}>Purchase value property
          <input style={input} value={m.purchaseValueProp || ''} onChange={(e) => setM({ ...m, purchaseValueProp: e.target.value })} placeholder="e.g. value" autoComplete="off" />
        </label>
        <label style={lbl}>Breakdown properties (the "What's driving it" chips)
          <textarea style={{ ...input, minHeight: 64, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} value={listVal('breakdownProps')} onChange={(e) => setList('breakdownProps', e.target.value)} placeholder={'interaction_type\nCTA_Label\nsurface'} />
        </label>
      </div>
      <div style={{ ...title, fontSize: 12.5, marginTop: 10 }}>Person profile properties</div>
      <div style={grid2}>
        {[['email', 'Email'], ['firstName', 'First name'], ['lastName', 'Surname'], ['phone', 'Mobile']].map(([k, label]) => (
          <label key={k} style={lbl}>{label}
            <input style={input} value={m.personProps?.[k] || ''} onChange={(e) => setPerson(k, e.target.value)} autoComplete="off" />
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
        <button type="button" style={btn} onClick={save}>Save mapping</button>
        {saved && <span style={okTxt}>✓ Saved — next sync uses it</span>}
        <button type="button" style={ghostBtn} onClick={async () => {
          setCatErr('');
          try { setCatalog((await api.posthogEventsCatalog()).events || []); } catch (e) { setCatErr(e.message); }
        }}>Show events catalog</button>
      </div>
      {catErr && <div style={errBox}>{catErr}</div>}
      {catalog && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
          {catalog.slice(0, 60).map((c) => (
            <span key={c.event} style={{ fontSize: 11.5, fontFamily: 'ui-monospace, monospace', border: '1px solid var(--hairline)', borderRadius: 6, padding: '3px 8px' }}>
              {c.event} <span style={{ color: 'var(--muted)' }}>· {fmt(c.count)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Ask PostHog what actually exists: does the configured event-id property carry
// values (and what do they look like next to core_events.id), and which property
// keys does the app really send — the fast answer to "whole app has data but a
// client's view is empty".
function DiagnoseCard() {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setBusy(true); setError('');
    try { setD(await api.posthogDiagnose()); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const KeyChips = ({ items, hint }) => items === null
    ? <p style={sub}>Couldn't list property keys on this PostHog version — check a raw event in PostHog itself.</p>
    : (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {items.map((k) => (
          <span key={k.key} style={{ fontSize: 11.5, fontFamily: 'ui-monospace, monospace', border: `1px solid ${hint && hint(k.key) ? 'var(--brand)' : 'var(--hairline)'}`, borderRadius: 6, padding: '3px 8px' }}>
            {k.key} <span style={{ color: 'var(--muted)' }}>· {fmt(k.count)}</span>
          </span>
        ))}
      </div>
    );
  return (
    <div style={{ ...card, marginTop: 12 }}>
      <div style={title}>🔬 Diagnose — is the event-ID wiring right?</div>
      <p style={sub}>Checks how many recent app events actually carry the configured event-ID property, shows sample values (they must match Looker's <code>core_events.id</code>), and lists the property keys the app really sends.</p>
      {!d && <button type="button" style={btn} disabled={busy} onClick={run}>{busy ? 'Checking…' : 'Run diagnosis'}</button>}
      {error && <div style={errBox}>{error}</div>}
      {d && (
        <>
          <p style={{ fontSize: 13, margin: '0 0 10px', fontWeight: 600, color: d.taggedEvents7d > 0 ? 'var(--success, #10b981)' : 'var(--danger, #dc2626)' }}>
            {d.taggedEvents7d > 0
              ? `✓ ${fmt(d.taggedEvents7d)} events in the last 7 days carry "${d.eventIdProp}" (${fmt(d.distinctIds7d)} distinct events)`
              : `✗ NO events in the last 7 days carry "${d.eventIdProp}" — the property is named differently. Pick the right key below, update it in Integrations → PostHog, then Sync now.`}
          </p>
          {d.sampleIds?.length > 0 && (
            <>
              <div style={{ ...title, fontSize: 12.5 }}>Busiest "{d.eventIdProp}" values (7d) — do these match core_events.id?</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                {d.sampleIds.map((s) => (
                  <span key={s.id} style={{ fontSize: 11.5, border: '1px solid var(--hairline)', borderRadius: 6, padding: '3px 8px' }}>
                    <b style={{ fontFamily: 'ui-monospace, monospace' }}>{s.id}</b>{s.name ? ` ${s.name}` : ''} <span style={{ color: 'var(--muted)' }}>· {fmt(s.count)}</span>
                  </span>
                ))}
              </div>
            </>
          )}
          <div style={{ ...title, fontSize: 12.5 }}>Event property keys the app sends (24h)</div>
          <KeyChips items={d.eventPropertyKeys} hint={(k) => /event/i.test(k) && /id/i.test(k)} />
          <div style={{ ...title, fontSize: 12.5 }}>Person profile property keys (for the App-users mapping)</div>
          <KeyChips items={d.personPropertyKeys} hint={(k) => /mail|name|phone|mobile|surname/i.test(k)} />
          <p style={{ ...mutedTxt, fontSize: 11.5 }}>Local rollup: {fmt(d.rollup?.eventRows)} event-day rows total · {fmt(d.rollup?.eventRowsLast7d)} in the last 7 days · {fmt(d.rollup?.appDays)} app days.</p>
          <ValueExplorer />
          <button type="button" style={ghostBtn} disabled={busy} onClick={run}>{busy ? 'Checking…' : 'Re-run'}</button>
        </>
      )}
    </div>
  );
}

// What does a property CONTAIN? Type an event + property key (from the chips
// above) and see its top values — copy-paste material for the mapping's
// `event : property=value` lines.
function ValueExplorer() {
  const [event, setEvent] = useState('interaction');
  const [key, setKey] = useState('');
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async (e) => {
    e?.preventDefault();
    if (!event.trim() || !key.trim()) return;
    setBusy(true); setError('');
    try { setOut(await api.posthogPropertyValues(event.trim(), key.trim())); } catch (err) { setError(err.message); }
    setBusy(false);
  };
  return (
    <div style={{ border: '1px dashed var(--hairline)', borderRadius: 10, padding: 12, margin: '4px 0 12px' }}>
      <div style={{ ...title, fontSize: 12.5 }}>Explore a property's values</div>
      <form style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} onSubmit={go}>
        <input style={{ ...input, flex: 1, minWidth: 140, marginTop: 0 }} value={event} onChange={(e) => setEvent(e.target.value)} placeholder="event, e.g. interaction" />
        <input style={{ ...input, flex: 1, minWidth: 140, marginTop: 0 }} value={key} onChange={(e) => setKey(e.target.value)} placeholder="property key, e.g. action" />
        <button type="submit" style={ghostBtn} disabled={busy || !event.trim() || !key.trim()}>{busy ? '…' : 'Show values'}</button>
      </form>
      {error && <div style={{ ...errBox, marginTop: 8 }}>{error}</div>}
      {out && (
        out.values.length === 0
          ? <p style={{ ...sub, marginTop: 8 }}>No values for "{out.key}" on "{out.event}" in the last 30 days — try another key from the chips above.</p>
          : (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
              {out.values.map((v) => (
                <span key={v.value} style={{ fontSize: 11.5, fontFamily: 'ui-monospace, monospace', border: '1px solid var(--hairline)', borderRadius: 6, padding: '3px 8px' }}>
                  {out.event} : {out.key}={v.value} <span style={{ color: 'var(--muted)' }}>· {fmt(v.count)}</span>
                </span>
              ))}
            </div>
          )
      )}
    </div>
  );
}

function Chip({ on, onClick, children }) {
  return (
    <button type="button" onClick={onClick}
      style={{ minHeight: 32, padding: '5px 12px', borderRadius: 980, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: `1px solid ${on ? 'var(--brand)' : 'var(--hairline)'}`, background: on ? 'var(--brand)' : 'transparent', color: on ? '#fff' : 'var(--muted)' }}>
      {children}
    </button>
  );
}

const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: 16, marginTop: 16 };
const title = { fontSize: 14, fontWeight: 700, marginBottom: 6 };
const sub = { fontSize: 13, color: 'var(--muted)', margin: '0 0 12px' };
const mutedTxt = { fontSize: 13, color: 'var(--muted)' };
const errBox = { background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.25)', color: 'var(--danger, #dc2626)', borderRadius: 10, padding: '10px 12px', fontSize: 12.5, marginBottom: 10 };
const okTxt = { color: 'var(--success, #10b981)', fontSize: 12.5, fontWeight: 600 };
const btn = { border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 980, padding: '9px 16px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', minHeight: 40 };
const ghostBtn = { border: '1px solid var(--hairline)', background: 'transparent', color: 'var(--text)', borderRadius: 980, padding: '9px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', minHeight: 40 };
const input = { display: 'block', width: '100%', marginTop: 4, padding: '9px 11px', borderRadius: 9, border: '1px solid var(--hairline)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13, minHeight: 40 };
const lbl = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--muted-2, var(--muted))', marginBottom: 8 };
const grid2 = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 };
const th = { textAlign: 'left', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', fontWeight: 700, padding: '6px 8px', borderBottom: '1px solid var(--hairline)', whiteSpace: 'nowrap' };
const dateInput = { minHeight: 32, padding: '4px 8px', borderRadius: 9, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 12, fontFamily: 'inherit' };
const td = { padding: '8px', borderBottom: '1px solid var(--hairline)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
