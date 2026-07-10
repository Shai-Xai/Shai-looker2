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
  const [days, setDays] = useState(28);
  const [entityId, setEntityId] = useState('');
  const [clients, setClients] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  useEffect(() => { api.adminListEntities().then((e) => setClients((e || []).map((x) => ({ id: x.id, name: x.name })))).catch(() => {}); }, []);
  const load = useCallback(() => {
    setError('');
    api.adminAppAnalytics({ days, entityId }).then(setData).catch((e) => { setError(e.message); setData(null); });
  }, [days, entityId]);
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
  const stats = perClient
    ? [
        ['Viewers today', data.live?.actives, true],
        ['Unique viewers', data.totals?.uniques],
        ['Views', data.totals?.views],
        ['CTA taps', data.totals?.ctaTaps],
        ['Purchases', data.totals?.purchases],
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
        {DAY_CHOICES.map((d) => <Chip key={d} on={days === d} onClick={() => setDays(d)}>{d}d</Chip>)}
        <button type="button" style={ghostBtn} disabled={syncing} onClick={async () => {
          setSyncing(true); setError('');
          try { await api.syncAppAnalytics(); load(); } catch (e) { setError(e.message); }
          setSyncing(false);
        }}>{syncing ? 'Syncing…' : '↻ Sync now'}</button>
      </div>
      {error && <div style={errBox}>{error}</div>}
      {data.liveError && <p style={{ ...mutedTxt, fontSize: 12 }}>{data.liveError}</p>}
      {perClient && data.scoped === false && (
        <div style={card}><p style={sub}>No Howler event ids resolve for this client yet — their suites need an event lock (name or id) before app data can be scoped to them.</p></div>
      )}

      <StatRow stats={stats} isMobile={isMobile} />
      <SeriesCard
        series={data.series || []}
        metrics={perClient
          ? [['views', 'Views'], ['uniques', 'Unique viewers'], ['ctaTaps', 'CTA taps'], ['purchases', 'Purchases']]
          : [['dau', 'Active users'], ['views', 'Views'], ['interactions', 'Interactions'], ['new_users', 'New users'], ['sessions', 'Sessions']]}
        isMobile={isMobile}
      />
      <EventsTable rows={perClient ? data.events : data.topEvents} title={perClient ? 'Their events in the app' : 'Top events by in-app attention'} days={data.days} />
      <PeopleSection loader={(opts) => api.adminAppPeople({ ...opts, entityId })} days={days} />
      {!perClient && <MappingEditor />}
      {data.lastSync && <p style={{ ...mutedTxt, fontSize: 11.5, marginTop: 10 }}>Rollup last synced {new Date(data.lastSync).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · live numbers refresh on load (≤5 min cache)</p>}
    </div>
  );
}

// ── Client-scoped panel (their events only; also the admin per-client lens) ─────
export function AppAnalyticsPanel({ entityId, scope = 'my' }) {
  const isMobile = useIsMobile();
  const [days, setDays] = useState(28);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!entityId) return;
    setError('');
    const req = scope === 'admin-client' ? api.adminAppAnalytics({ days, entityId }) : api.myAppAnalytics(entityId, days);
    req.then(setData).catch((e) => { setError(e.message); setData(null); });
  }, [entityId, scope, days]);

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
        {DAY_CHOICES.map((d) => <Chip key={d} on={days === d} onClick={() => setDays(d)}>{d}d</Chip>)}
      </div>
      {data.liveError && <p style={{ ...mutedTxt, fontSize: 12 }}>{data.liveError}</p>}
      <StatRow isMobile={isMobile} stats={[
        ['Viewers today', data.live?.actives, true],
        ['Unique viewers', data.totals?.uniques],
        ['Views', data.totals?.views],
        ['CTA taps', data.totals?.ctaTaps],
        ['Purchases', data.totals?.purchases],
      ]} />
      <SeriesCard series={data.series || []} isMobile={isMobile}
        metrics={[['views', 'Views'], ['uniques', 'Unique viewers'], ['ctaTaps', 'CTA taps'], ['purchases', 'Purchases']]} />
      <EventsTable rows={data.events} title="By event" days={data.days} />
      <PeopleSection days={days}
        loader={(opts) => (scope === 'admin-client' ? api.adminAppPeople({ ...opts, entityId }) : api.myAppPeople(entityId, opts))} />
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

function EventsTable({ rows, title: heading, days }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div style={{ ...card, marginTop: 12, overflowX: 'auto' }}>
      <div style={title}>{heading}</div>
      <p style={sub}>Last {days} days · sorted by unique viewers</p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 520 }}>
        <thead><tr>{['Event', 'Uniques', 'Views', 'Interactions', 'CTA taps', 'Purchases'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.eventRef}>
              <td style={{ ...td, fontWeight: 600 }}>{r.eventName || `Event ${r.eventRef}`}<span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {r.eventRef}</span></td>
              <td style={td}>{fmt(r.uniques)}</td><td style={td}>{fmt(r.views)}</td><td style={td}>{fmt(r.interactions)}</td>
              <td style={td}>{fmt(r.ctaTaps)}</td><td style={td}>{fmt(r.purchases)}{r.purchaseValue > 0 && <span style={{ color: 'var(--muted)' }}> · {fmt(r.purchaseValue)}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// App-user profiles (PostHog person properties). Loaded on demand — live PostHog
// queries are scarce, so nothing fires until someone asks for the list.
function PeopleSection({ loader, days }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async (term) => {
    setBusy(true); setError('');
    try { setRows((await loader({ days, q: term })).people || []); }
    catch (e) { setError(e.message); }
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
          <form style={{ display: 'flex', gap: 8, marginBottom: 10 }} onSubmit={(e) => { e.preventDefault(); load(q); }}>
            <input style={{ ...input, flex: 1 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email or mobile…" />
            <button type="submit" style={ghostBtn} disabled={busy}>{busy ? '…' : 'Search'}</button>
          </form>
          {error && <div style={errBox}>{error}</div>}
          {busy && !rows && <p style={mutedTxt}>Loading…</p>}
          {rows && rows.length === 0 && <p style={sub}>No app users found in this window.</p>}
          {rows && rows.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 560 }}>
                <thead><tr>{['Name', 'Email', 'Mobile', 'Last seen', 'Events'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {rows.map((p, i) => (
                    <tr key={i}>
                      <td style={{ ...td, fontWeight: 600 }}>{[p.firstName, p.lastName].filter(Boolean).join(' ') || '—'}</td>
                      <td style={td}>{p.email || '—'}</td>
                      <td style={td}>{p.phone || '—'}</td>
                      <td style={td}>{p.lastSeen ? new Date(p.lastSeen).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                      <td style={{ ...td, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{(p.eventNames || []).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
      <p style={sub}>Tell Pulse which PostHog events mean what — one event name per line. The catalog shows what the app actually sends, busiest first.</p>
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
const td = { padding: '8px', borderBottom: '1px solid var(--hairline)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
