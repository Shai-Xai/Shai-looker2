import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { vtNavigate } from '../lib/viewTransition.js';
import ReactECharts from 'echarts-for-react/lib/core';
import echarts from '../lib/echarts.js';
import { brandPrimary } from '../lib/brand.js';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import DashboardInsightModal from './DashboardInsightModal.jsx';
import AiMark from './AiMark.jsx';

// 📱 App analytics — the UI over server/posthog.js (direct PostHog integration).
// Three exports:
//   PosthogSettingsCard — the platform connection card (Admin → Integrations)
//   AppAnalyticsAdmin   — the management tab (whole app, every client) with the
//                         event-mapping editor + app-user profiles
//   AppAnalyticsPanel   — the client-scoped view (scope 'my' | 'admin-client'),
//                         used by the client's App page and the admin lens
// Uninstall with server/posthog.js — see that file's header.

const fmt = (n) => (n == null ? '—' : Intl.NumberFormat('en-ZA', { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n));
// Rand amounts (in-app revenue tracked by PostHog) — compact above 100k.
const fmtR = (v) => (v == null ? '—' : `R${Intl.NumberFormat('en-ZA', { notation: v >= 100000 ? 'compact' : 'standard', maximumFractionDigits: v >= 100000 ? 1 : 0 }).format(v)}`);
// Seconds → "4m 32s" / "1h 12m" for the time-in-app tiles.
const fmtDur = (s) => {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m` : m ? (sec ? `${m}m ${sec}s` : `${m}m`) : `${sec}s`;
};
const DAY_CHOICES = [7, 28, 90];
const HOURLY_MAX_DAYS = 14; // matches the server cap

// ── window state: an inclusive {from,to} date range + a day/hour granularity ────
const isoDay = (offset = 0) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
const presetRange = (days) => ({ from: isoDay(-(days - 1)), to: isoDay(0) });
const rangeDays = (r) => Math.round((Date.parse(r.to) - Date.parse(r.from)) / 86400_000) + 1;
const clampHourly = (r) => (rangeDays(r) > HOURLY_MAX_DAYS
  ? { from: new Date(Date.parse(r.to) - (HOURLY_MAX_DAYS - 1) * 86400_000).toISOString().slice(0, 10), to: r.to }
  : r);

// Daily/Hourly toggle + ONE compact date-range chip (opens a small modal with
// both pickers — two naked date inputs wrapped messily on phones) + quick
// presets. Hourly ranges are clamped to the server's 14-day cap.
const fmtDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
function WindowControls({ gran, setGran, range, setRange }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(range);
  const apply = (next, g = gran) => {
    if (next.from > next.to) next = { from: next.to, to: next.from };
    setRange(g === 'hour' ? clampHourly(next) : next);
  };
  const pick = (g) => { setGran(g); if (g === 'hour') setRange(clampHourly(range)); };
  return (
    <>
      <Chip on={gran === 'day'} onClick={() => pick('day')}>Daily</Chip>
      <Chip on={gran === 'hour'} onClick={() => pick('hour')}>Hourly</Chip>
      <Chip onClick={() => { setDraft(range); setOpen(true); }}>
        📅 {range.from === range.to ? fmtDay(range.from) : `${fmtDay(range.from)} – ${fmtDay(range.to)}`}
      </Chip>
      {open && (
        <div style={overlay} onClick={() => setOpen(false)}>
          <div style={modal} onClick={(e) => e.stopPropagation()}>
            <div style={{ ...title, marginBottom: 2 }}>📅 Date range</div>
            <p style={{ ...sub, marginBottom: 10 }}>Both dates inclusive{gran === 'hour' ? ` · hourly view covers at most ${HOURLY_MAX_DAYS} days` : ''}.</p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              <Chip on={range.from === isoDay(0) && range.to === isoDay(0)} onClick={() => { setGran('hour'); apply({ from: isoDay(0), to: isoDay(0) }, 'hour'); setOpen(false); }}>Today</Chip>
              {DAY_CHOICES.map((d) => (
                <Chip key={d} on={range.from === presetRange(d).from && range.to === isoDay(0)}
                  onClick={() => { if (d > HOURLY_MAX_DAYS && gran === 'hour') setGran('day'); apply(presetRange(d), d > HOURLY_MAX_DAYS ? 'day' : gran); setOpen(false); }}>{d}d</Chip>
              ))}
            </div>
            <label style={lbl}>From
              <input type="date" style={{ ...input, colorScheme: 'inherit' }} value={draft.from} max={isoDay(0)} onChange={(e) => e.target.value && setDraft({ ...draft, from: e.target.value })} />
            </label>
            <label style={lbl}>To
              <input type="date" style={{ ...input, colorScheme: 'inherit' }} value={draft.to} max={isoDay(0)} onChange={(e) => e.target.value && setDraft({ ...draft, to: e.target.value })} />
            </label>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <button type="button" style={ghostBtn} onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" style={btn} onClick={() => { apply(draft); setOpen(false); }}>Apply</button>
            </div>
          </div>
        </div>
      )}
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

// ── 📤 PostHog warehouse bridge (Integrations, next to the connection card) ─────
// Feeds Howler ORDER rows (via Looker) to PostHog's Custom REST source — the
// bridge while the core Howler API is built. Token write-only (shown once);
// the organiser allowlist fails closed.
export function PosthogFeedCard() {
  const [v, setV] = useState(null);
  const [orgsText, setOrgsText] = useState('');
  const [freshToken, setFreshToken] = useState('');
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.feedsSettings().then((s) => { setV(s); setOrgsText((s.orgs || []).join('\n')); }).catch(() => {}); }, []);
  if (!v) return null;
  const url = `${window.location.origin}${v.path}`;
  return (
    <div style={{ ...card, marginTop: 12 }}>
      <div style={title}>📤 Feed Howler orders INTO PostHog (bridge)</div>
      <p style={sub}>Point PostHog's <b>Data pipeline → Sources → Custom REST source</b> at this endpoint and its warehouse gets order rows (amount, status, event, purchaser email) for the allowlisted organisers — no Howler-core API needed yet. Re-pull a trailing week on the schedule so refunds restate. Retire this when the core API ships.</p>
      <label style={lbl}>Endpoint (add ?since=YYYY-MM-DD for incremental pulls)
        <input style={{ ...input, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} value={url} readOnly onFocus={(e) => e.target.select()} />
      </label>
      <label style={{ ...lbl, marginTop: 10 }}>Organiser allowlist — one per line, exactly as named in Looker (empty = feed OFF)
        <textarea style={{ ...input, minHeight: 64, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} value={orgsText} onChange={(e) => setOrgsText(e.target.value)} placeholder={'G&G Productions'} />
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
        <button type="button" style={btn} onClick={async () => {
          setError('');
          try { await api.saveFeedsSettings({ orgs: orgsText }); setV(await api.feedsSettings()); setSaved(true); setTimeout(() => setSaved(false), 1600); }
          catch (e) { setError(e.message); }
        }}>Save allowlist</button>
        <button type="button" style={ghostBtn} onClick={async () => {
          setError('');
          try { const r = await api.generateFeedToken(); setFreshToken(r.token); setV(await api.feedsSettings()); }
          catch (e) { setError(e.message); }
        }}>{v.tokenSet ? '↻ Rotate token' : 'Generate token'}</button>
        {v.tokenSet && !freshToken && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Token set ({v.tokenHint})</span>}
        <button type="button" style={ghostBtn} onClick={async () => {
          setError(''); setPreview(null);
          try { setPreview(await api.previewFeed()); } catch (e) { setError(e.message); }
        }}>Preview rows</button>
        {saved && <span style={okTxt}>✓ Saved</span>}
      </div>
      {freshToken && (
        <p style={{ fontSize: 12.5, marginTop: 10 }}>
          Bearer token (copy NOW — it won't be shown again):{' '}
          <code style={{ userSelect: 'all', wordBreak: 'break-all' }}>{freshToken}</code>
        </p>
      )}
      {error && <div style={errBox}>{error}</div>}
      {preview && (
        <p style={{ ...sub, marginTop: 10 }}>
          {preview.orders.length
            ? `✓ Serving rows — first: order ${preview.orders[0].order_id} · ${preview.orders[0].event_name || preview.orders[0].event_id} · ${preview.orders[0].status} · R${preview.orders[0].amount} (emails masked in preview only)`
            : 'No rows yet — check the organiser names match Looker exactly.'}
        </p>
      )}
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
  const [moments, setMoments] = useState([]);
  const [linkClicks, setLinkClicks] = useState([]);
  const [owlSel, setOwlSel] = useState(null); // { ids: null|string[], label } → opens the summary
  const [owlPick, setOwlPick] = useState(false);
  const load = useCallback(() => {
    setError('');
    api.adminAppAnalytics({ from: range.from, to: range.to, entityId }).then(setData).catch((e) => { setError(e.message); setData(null); });
    api.adminAppMoments({ from: range.from, to: range.to, entityId }).then((r) => { setMoments(r.moments || []); setLinkClicks(r.linkClicks || []); }).catch(() => { setMoments([]); setLinkClicks([]); });
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
        ...[['Views', data.totals?.views], ['CTA taps', data.totals?.ctaTaps], ['Purchases', data.totals?.purchases], ['Notifications', data.totals?.notifications]].filter(([, v]) => v > 0),
        ...(data.totals?.purchaseValue > 0 ? [['In-app revenue', fmtR(data.totals.purchaseValue)]] : []),
        ...(data.time?.sessions > 0 ? [['Avg session', fmtDur(data.time.avgSessionSec)], ['Time / user', fmtDur(data.time.avgUserSec)]] : []),
      ]
    : [
        ['Active today', data.live?.actives, true],
        ['Weekly active', headline.wau],
        ['Monthly active', headline.mau],
        ['New users', data.totals?.newUsers],
        ['Sessions', data.totals?.sessions],
        ['Interactions', data.totals?.interactions],
        ...[['Notifications', data.totals?.notifEvents]].filter(([, v]) => v > 0),
        ...(data.time?.sessions > 0 ? [['Avg session', fmtDur(data.time.avgSessionSec)], ['Time / user', fmtDur(data.time.avgUserSec)]] : []),
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
        <OwlBtn onClick={() => (entityId
          ? setOwlSel({ ids: [entityId], label: clients.find((c) => c.id === entityId)?.name || 'This client' })
          : setOwlPick(true))} />
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
      {owlPick && <OwlScopePicker clients={clients} onClose={() => setOwlPick(false)}
        onPick={(sel) => { setOwlPick(false); setOwlSel(sel); }} />}
      {owlSel && (
        <DashboardInsightModal
          kindLabel="App summary" title={owlSel.label}
          endpoint={`/api/admin/app-analytics/insight?from=${range.from}&to=${range.to}${owlSel.ids ? `&entityIds=${encodeURIComponent(owlSel.ids.join(','))}` : ''}`}
          payload={{}} onClose={() => setOwlSel(null)} />
      )}
      {error && <div style={errBox}>{error}</div>}
      {data.liveError && <p style={{ ...mutedTxt, fontSize: 12 }}>{data.liveError}</p>}
      {perClient && data.scoped === false && (
        <div style={card}><p style={sub}>No Howler event ids resolve for this client yet — their suites need an event lock (name or id) before app data can be scoped to them.</p></div>
      )}

      <StatRow stats={stats} isMobile={isMobile} />
      {gran === 'hour' ? (
        <TodayChart key={`hourly-${winKey}`} moments={moments} loader={() => api.adminAppToday({ entityId, from: range.from, to: range.to })} />
      ) : (
      <SeriesCard
        key={`series-${winKey}`}
        series={data.series || []}
        moments={moments}
        linkClicks={linkClicks}
        events={(perClient ? data.events : data.topEvents) || []}
        eventSeriesLoader={(refs) => api.adminAppEventSeries({ from: range.from, to: range.to, entityId, events: refs.join(',') })}
        metrics={perClient
          ? [['uniques', 'Unique viewers'], ['interactions', 'Interactions'],
              ...[['views', 'Views', data.totals?.views], ['ctaTaps', 'CTA taps', data.totals?.ctaTaps], ['purchases', 'Purchases', data.totals?.purchases], ['notifications', 'Notifications', data.totals?.notifications]].filter(([, , v]) => v > 0).map(([k, l]) => [k, l])]
          : [['dau', 'Active users'], ['views', 'Views'], ['interactions', 'Interactions'], ['new_users', 'New users'], ['sessions', 'Sessions'],
              ...[['notif_events', 'Notifications', data.totals?.notifEvents]].filter(([, , v]) => v > 0).map(([k, l]) => [k, l])]}
        isMobile={isMobile}
      />
      )}
      <EventsTable rows={perClient ? data.events : data.topEvents} title={perClient ? 'Their events in the app' : 'Top events by in-app attention'} days={data.days} />
      <BreakdownsCard key={`bd-${winKey}-${gran}`} keys={data.breakdowns || []}
        loader={(key) => api.adminAppBreakdown({ key, from: range.from, to: range.to, entityId })}
        seriesLoader={(key) => api.adminAppBreakdownSeries({ key, from: range.from, to: range.to, entityId, granularity: gran })} />
      <FunnelCard key={`fun-${winKey}`} admin loader={() => api.adminAppFunnel({ from: range.from, to: range.to, entityId })} />
      <CtaLabelsCard key={`cta-${winKey}`} admin loader={() => api.adminAppCtaLabels({ from: range.from, to: range.to, entityId })} />
      {perClient && <AudienceMatchCard entityId={entityId} scope="admin-client" events={data.events || []} isMobile={isMobile} />}
      <TopUsersCard key={`top-${winKey}`} win={range} loader={(opts) => api.adminAppPeople({ ...opts, from: range.from, to: range.to, entityId })} />
      <PeopleSection key={`ppl-${winKey}`} win={range} loader={(opts) => api.adminAppPeople({ ...opts, from: range.from, to: range.to, entityId })}
        ticketsLoader={perClient ? (emails) => api.appTickets(entityId, 'admin-client', emails) : null}
        exportUrl={(q) => `/api/admin/app-analytics/people.csv?from=${range.from}&to=${range.to}&entityId=${encodeURIComponent(entityId)}&q=${encodeURIComponent(q || '')}`} />
      {!perClient && <MappingEditor />}
      {!perClient && <DiagnoseCard />}
      {!perClient && <CommerceScanCard />}
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
  const [moments, setMoments] = useState([]);
  const [linkClicks, setLinkClicks] = useState([]);
  const [owlOpen, setOwlOpen] = useState(false);
  useEffect(() => {
    if (!entityId) return;
    setError('');
    const w = { from: range.from, to: range.to };
    const req = scope === 'admin-client' ? api.adminAppAnalytics({ ...w, entityId }) : api.myAppAnalytics(entityId, w);
    req.then(setData).catch((e) => { setError(e.message); setData(null); });
    (scope === 'admin-client' ? api.adminAppMoments({ ...w, entityId }) : api.myAppMoments(entityId, w))
      .then((r) => { setMoments(r.moments || []); setLinkClicks(r.linkClicks || []); }).catch(() => { setMoments([]); setLinkClicks([]); });
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
        {/* The intro sentence squeezes the control chips into ragged wrapping on
            phones — the page is titled "App", so the copy is desktop-only. */}
        {!isMobile && <span style={{ flex: 1, fontSize: 12.5, color: 'var(--muted)' }} title="How your events perform inside the Howler app.">How your events perform inside the Howler app.</span>}
        <WindowControls gran={gran} setGran={setGran} range={range} setRange={setRange} />
        <OwlBtn onClick={() => setOwlOpen(true)} />
      </div>
      {owlOpen && (
        <DashboardInsightModal
          kindLabel="App summary" title="Your events in the Howler app"
          endpoint={scope === 'admin-client'
            ? `/api/admin/app-analytics/insight?entityIds=${encodeURIComponent(entityId)}&from=${range.from}&to=${range.to}`
            : `/api/my/app-analytics/${entityId}/insight?from=${range.from}&to=${range.to}`}
          payload={{}} onClose={() => setOwlOpen(false)} />
      )}
      {data.liveError && <p style={{ ...mutedTxt, fontSize: 12 }}>{data.liveError}</p>}
      <StatRow isMobile={isMobile} stats={[
        ['Viewers today', data.live?.actives, true],
        ['Unique viewers', data.live?.windowUniques ?? data.totals?.uniques, data.live?.windowUniques != null],
        ['Interactions', data.totals?.interactions],
        // unmapped/empty metrics stay hidden until they have data (see AppAnalyticsAdmin)
        ...[['Views', data.totals?.views], ['CTA taps', data.totals?.ctaTaps], ['Purchases', data.totals?.purchases], ['Notifications', data.totals?.notifications]].filter(([, v]) => v > 0),
        ...(data.totals?.purchaseValue > 0 ? [['In-app revenue', fmtR(data.totals.purchaseValue)]] : []),
        ...(data.time?.sessions > 0 ? [['Avg session', fmtDur(data.time.avgSessionSec)], ['Time / user', fmtDur(data.time.avgUserSec)]] : []),
      ]} />
      {gran === 'hour' ? (
        <TodayChart key={`hourly-${winKey}`} moments={moments} loader={() => (scope === 'admin-client' ? api.adminAppToday({ entityId, from: range.from, to: range.to }) : api.myAppToday(entityId, { from: range.from, to: range.to }))} />
      ) : (
      <SeriesCard key={`series-${winKey}`} series={data.series || []} moments={moments} linkClicks={linkClicks} isMobile={isMobile}
        events={data.events || []}
        eventSeriesLoader={(refs) => (scope === 'admin-client'
          ? api.adminAppEventSeries({ from: range.from, to: range.to, entityId, events: refs.join(',') })
          : api.myAppEventSeries(entityId, { from: range.from, to: range.to, events: refs.join(',') }))}
        metrics={[['uniques', 'Unique viewers'], ['interactions', 'Interactions'],
          ...[['views', 'Views', data.totals?.views], ['ctaTaps', 'CTA taps', data.totals?.ctaTaps], ['purchases', 'Purchases', data.totals?.purchases], ['notifications', 'Notifications', data.totals?.notifications]].filter(([, , v]) => v > 0).map(([k, l]) => [k, l])]} />
      )}
      <EventsTable rows={data.events} title="By event" days={data.days} />
      <BreakdownsCard key={`bd-${winKey}-${gran}`} keys={data.breakdowns || []}
        loader={(key) => (scope === 'admin-client' ? api.adminAppBreakdown({ key, from: range.from, to: range.to, entityId }) : api.myAppBreakdown(entityId, { key, from: range.from, to: range.to }))}
        seriesLoader={(key) => (scope === 'admin-client' ? api.adminAppBreakdownSeries({ key, from: range.from, to: range.to, entityId, granularity: gran }) : api.myAppBreakdownSeries(entityId, { key, from: range.from, to: range.to, granularity: gran }))} />
      <FunnelCard key={`fun-${winKey}`} admin={scope === 'admin-client'}
        loader={() => (scope === 'admin-client' ? api.adminAppFunnel({ from: range.from, to: range.to, entityId }) : api.myAppFunnel(entityId, { from: range.from, to: range.to }))} />
      <CtaLabelsCard key={`cta-${winKey}`} admin={scope === 'admin-client'}
        loader={() => (scope === 'admin-client' ? api.adminAppCtaLabels({ from: range.from, to: range.to, entityId }) : api.myAppCtaLabels(entityId, { from: range.from, to: range.to }))} />
      <AudienceMatchCard entityId={entityId} scope={scope} events={data.events || []} isMobile={isMobile} />
      <TopUsersCard key={`top-${winKey}`} win={range}
        loader={(opts) => (scope === 'admin-client' ? api.adminAppPeople({ ...opts, from: range.from, to: range.to, entityId }) : api.myAppPeople(entityId, { ...opts, from: range.from, to: range.to }))} />
      <PeopleSection key={`ppl-${winKey}`} win={range}
        loader={(opts) => (scope === 'admin-client' ? api.adminAppPeople({ ...opts, from: range.from, to: range.to, entityId }) : api.myAppPeople(entityId, { ...opts, from: range.from, to: range.to }))}
        ticketsLoader={(emails) => api.appTickets(entityId, scope, emails)}
        exportUrl={(q) => (scope === 'admin-client'
          ? `/api/admin/app-analytics/people.csv?from=${range.from}&to=${range.to}&entityId=${encodeURIComponent(entityId)}&q=${encodeURIComponent(q || '')}`
          : `/api/my/app-analytics/${entityId}/people.csv?from=${range.from}&to=${range.to}&q=${encodeURIComponent(q || '')}`)} />
    </div>
  );
}

// ── shared pieces ────────────────────────────────────────────────────────────────
function StatRow({ stats, isMobile }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${isMobile ? 130 : 150}px, 1fr))`, gap: 8, marginBottom: 12 }}>
      {stats.map(([label, v, live]) => (
        <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: '11px 13px' }}>
          <div style={{ fontSize: 22, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{typeof v === 'string' ? v : fmt(v)}</div>
          <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginTop: 2 }}>
            {label}{live && v != null && <span style={{ color: 'var(--success, #10b981)' }}> · live</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

// Moments (community posts, campaign sends) drawn on the charts so spikes line
// up with their cause. Campaigns = full-height dashed lines; posts = STEMS whose
// height scales with that post's views (impressions, falling back to reach) —
// taller stem, more-seen post. Tap any marker for its detail card. Campaign
// #3b82f6 / post #0d9488 — validated series palette members.
const MOMENT_COLOR = { campaign: '#3b82f6', post: '#0d9488' };
const postViews = (m) => (m.impressions != null ? m.impressions : m.reach != null ? m.reach : null);
const momentKey = (m) => `${m.type}|${m.at}|${m.label}`;
// marks entries carry their index as the data `name` — the emphasis label and
// the click handler both resolve back through it.
function momentMarkLine(marks, toX, seriesMax) {
  const maxV = Math.max(0, ...marks.filter((m) => m.type === 'post').map((m) => postViews(m) || 0));
  return {
    symbol: 'none', animation: false,
    label: { show: false },
    emphasis: { lineStyle: { width: 4 }, label: { show: true, formatter: (pp) => { const m = marks[Number(pp.name)]; return m ? `${m.type === 'campaign' ? '📣' : '👥'} ${m.label}` : ''; }, fontSize: 10, color: 'var(--text, #333)' } },
    data: marks.map((m, i) => {
      const x = toX(m);
      if (x == null) return null;
      const style = { color: MOMENT_COLOR[m.type] || '#888', width: m.type === 'post' ? 2.5 : 1.5, opacity: 0.8, type: 'dashed' };
      if (m.type === 'post' && seriesMax > 0) {
        const v = postViews(m);
        const h = seriesMax * (maxV > 0 && v != null ? 0.15 + 0.85 * (v / maxV) : 0.5);
        return [{ coord: [x, 0], name: String(i), lineStyle: style }, { coord: [x, h] }];
      }
      return { name: String(i), xAxis: x, lineStyle: style };
    }).filter(Boolean),
  };
}
// Click → the moment's detail card (post text + views/reactions, campaign tag).
const momentClick = (marks, setDetail) => (p) => {
  if (p.componentType !== 'markLine') return;
  const m = marks[Number(p.data?.name ?? p.name)];
  if (m) setDetail(m);
};
function MomentDetail({ m, onClose }) {
  if (!m) return null;
  const stats = m.type === 'post'
    ? [['Views', postViews(m)], ['Impressions', m.impressions], ['Reach', m.reach], ['Reactions', m.reactions], ['Comments', m.comments], ['Shares', m.shares]].filter(([, v]) => v != null)
    : [];
  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...title, marginBottom: 2 }}>{m.type === 'campaign' ? '📣 Campaign' : `👥 ${m.community || 'Community post'}`}</div>
        <p style={{ ...sub, marginBottom: 8 }}>{new Date(m.at).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}{m.type === 'campaign' && m.tag ? ` · tagged ${m.tag}` : ''}</p>
        <p style={{ fontSize: 13.5, margin: '0 0 10px', lineHeight: 1.5 }}>{m.type === 'post' ? (m.text || m.label) : m.label}</p>
        {stats.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))', gap: 8 }}>
            {stats.map(([l, v]) => (
              <div key={l} style={{ border: '1px solid var(--hairline)', borderRadius: 10, padding: '8px 10px' }}>
                <div style={{ fontSize: 17, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{fmt(v)}</div>
                <div style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>{l}</div>
              </div>
            ))}
          </div>
        )}
        {m.type === 'post' && stats.length === 0 && <p style={sub}>No view stats captured for this post yet.</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" style={ghostBtn} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
// The Posts chip opens a picker: every post in the window, individually
// toggleable (hidden set), with its views alongside.
function PostPicker({ posts, hidden, setHidden, onClose }) {
  const allOff = posts.every((m) => hidden.has(momentKey(m)));
  return (
    <div style={overlay} onClick={onClose}>
      <div style={{ ...modal, maxWidth: 420, maxHeight: '70vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...title, marginBottom: 2 }}>👥 Posts on the chart</div>
        <p style={{ ...sub, marginBottom: 8 }}>Tick a post to show its marker — stem height tracks its views.</p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button type="button" style={ghostBtn} onClick={() => setHidden(new Set())}>All on</button>
          <button type="button" style={ghostBtn} onClick={() => setHidden(new Set(posts.map(momentKey)))}>All off</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {posts.map((m) => {
            const k = momentKey(m);
            const v = postViews(m);
            return (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, minHeight: 36, cursor: 'pointer' }}>
                <input type="checkbox" checked={!hidden.has(k)} onChange={() => setHidden((h) => { const n = new Set(h); if (n.has(k)) n.delete(k); else n.add(k); return n; })} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</span>
                <span style={{ color: 'var(--muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{String(m.at).slice(5, 10)}{v != null ? ` · ${fmt(v)} views` : ''}</span>
              </label>
            );
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
          <button type="button" style={btn} onClick={onClose}>{allOff ? 'Close (all hidden)' : 'Done'}</button>
        </div>
      </div>
    </div>
  );
}
function MomentToggles({ moments, hiddenPosts, setHiddenPosts, showCampaigns, setShowCampaigns, showOther, setShowOther, openPicker }) {
  const posts = moments.filter((m) => m.type === 'post');
  const nShown = posts.filter((m) => !hiddenPosts.has(momentKey(m))).length;
  const nApp = moments.filter((m) => m.type === 'campaign' && m.appLinked).length;
  const nOther = moments.filter((m) => m.type === 'campaign' && !m.appLinked).length;
  if (!posts.length && !nApp && !nOther) return null;
  return (
    <>
      {nApp > 0 && <Chip on={showCampaigns} onClick={() => setShowCampaigns(!showCampaigns)}>📣 App campaigns ({nApp})</Chip>}
      {posts.length > 0 && <Chip on={nShown > 0} onClick={openPicker}>👥 Posts ({nShown}/{posts.length}) ▾</Chip>}
      {nOther > 0 && <Chip on={showOther} onClick={() => setShowOther(!showOther)}>📣 Other campaigns ({nOther})</Chip>}
    </>
  );
}
// App-relevant campaigns (tagged 'app' in the composer, or auto-detected via an
// app link in the content) show by default; other campaigns are opt-in. Posts
// hide individually via the picker.
const shownMoments = (moments, hiddenPosts, showCampaigns, showOther) =>
  (moments || []).filter((m) => (m.type === 'post' ? !hiddenPosts.has(momentKey(m)) : m.type === 'campaign' ? (m.appLinked ? showCampaigns : showOther) : false)).slice(0, 60);

// The 🎪 Events chip opens a picker: All events = the combined line; ticking
// events (up to 8) draws each as its own line for comparison.
function EventPicker({ events, sel, setSel, onClose }) {
  return (
    <div style={overlay} onClick={onClose}>
      <div style={{ ...modal, maxWidth: 420, maxHeight: '70vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...title, marginBottom: 2 }}>🎪 Events on the chart</div>
        <p style={{ ...sub, marginBottom: 8 }}>All events = one combined line. Tick events (up to 8) to compare them — each gets its own line.</p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button type="button" style={ghostBtn} onClick={() => setSel(null)}>All events (combined)</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {events.map((e) => {
            const k = String(e.eventRef);
            const on = !!sel && sel.has(k);
            return (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, minHeight: 36, cursor: 'pointer' }}>
                <input type="checkbox" checked={on}
                  onChange={() => setSel((s) => {
                    const n = new Set(s || []);
                    if (n.has(k)) n.delete(k); else if (n.size < 8) n.add(k);
                    return n.size ? n : null;
                  })} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.eventName || `Event ${k}`}</span>
                <span style={{ color: 'var(--muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{k}</span>
              </label>
            );
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
          <button type="button" style={btn} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// One recessive line chart; chips pick WHICH single series shows (one axis, no
// dual scales). `series` rows are the rollup rows keyed by `date`. With events
// picked (🎪), the chart compares them — one line per event of the same metric.
function SeriesCard({ series, metrics, moments = [], linkClicks = [], isMobile, events = [], eventSeriesLoader }) {
  const [metric, setMetric] = useState(metrics[0][0]);
  const [hiddenPosts, setHiddenPosts] = useState(() => new Set());
  const [showCampaigns, setShowCampaigns] = useState(true);
  const [showOther, setShowOther] = useState(false);
  const [showClicks, setShowClicks] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [eventSel, setEventSel] = useState(null); // null = All (one combined line)
  const [evOpen, setEvOpen] = useState(false);
  const [evData, setEvData] = useState(null);
  const [evErr, setEvErr] = useState('');
  const totalClicks = linkClicks.reduce((a, r) => a + (r.clicks || 0), 0);
  const marks = shownMoments(moments, hiddenPosts, showCampaigns, showOther);
  const selKey = eventSel ? [...eventSel].sort().join(',') : '';
  const perEvent = !!eventSel && eventSel.size > 0;
  useEffect(() => {
    if (!perEvent || !eventSeriesLoader) { setEvData(null); return; }
    let dead = false;
    setEvErr('');
    eventSeriesLoader([...eventSel]).then((r) => { if (!dead) setEvData(r); }).catch((e) => { if (!dead) { setEvErr(e.message); setEvData(null); } });
    return () => { dead = true; };
  }, [selKey]); // eslint-disable-line react-hooks/exhaustive-deps -- loader is stable per mount; selKey encodes the selection
  const option = useMemo(() => {
    const brand = brandPrimary();
    const metricLabel = (metrics.find(([k]) => k === metric) || [])[1] || metric;
    const withClicks = !perEvent && showClicks && linkClicks.length > 0;
    const toX = (m) => String(m.at).replace('T', ' ').slice(0, 19);
    let lines;
    if (perEvent && evData) {
      // one line per picked event, same metric, fixed validated palette
      const names = new Map(evData.events.map((e) => [e.eventRef, e.eventName || `Event ${e.eventRef}`]));
      const byRef = new Map();
      for (const r of evData.series) { if (!byRef.has(r.eventRef)) byRef.set(r.eventRef, []); byRef.get(r.eventRef).push([r.date, r[metric] == null ? 0 : r[metric]]); }
      const maxV = Math.max(0, ...evData.series.map((r) => r[metric] || 0));
      lines = [...byRef.entries()].map(([ref, data], i) => ({
        name: names.get(ref) || ref, type: 'line', showSymbol: data.length < 3, smooth: 0.15,
        lineStyle: { width: 2, color: SERIES_COLORS[i % SERIES_COLORS.length] }, itemStyle: { color: SERIES_COLORS[i % SERIES_COLORS.length] },
        data,
        ...(i === 0 ? { markLine: momentMarkLine(marks, toX, maxV) } : {}),
      }));
    } else {
      lines = [{
        name: metricLabel,
        type: 'line', showSymbol: false, smooth: 0.15,
        lineStyle: { width: 2, color: brand }, itemStyle: { color: brand },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: `${brand}45` }, { offset: 1, color: `${brand}05` }]) },
        data: series.map((r) => [r.date, r[metric] == null ? 0 : r[metric]]),
        markLine: momentMarkLine(marks, toX, Math.max(0, ...series.map((r) => r[metric] || 0))),
      },
      // ChottuLink clicks ride the SAME count axis (both are event counts) as a
      // thin dashed companion line — never a second y-axis.
      ...(withClicks ? [{
        name: '🔗 Link clicks',
        type: 'line', showSymbol: false, smooth: 0.15,
        lineStyle: { width: 2, type: 'dashed', color: '#0891b2' }, itemStyle: { color: '#0891b2' },
        data: linkClicks.map((r) => [r.date, r.clicks]),
      }] : [])];
    }
    const legend = withClicks || (perEvent && lines.length > 1);
    return {
      animationDuration: 300,
      grid: { left: 8, right: 12, top: legend ? 30 : 12, bottom: 8, containLabel: true },
      legend: legend ? { top: 0, left: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 12, textStyle: { color: 'var(--muted, #888)', fontSize: 11 } } : undefined,
      tooltip: { trigger: 'axis', valueFormatter: (v) => (v == null ? '—' : Number(v).toLocaleString('en-ZA')), extraCssText: 'z-index: 40;' },
      xAxis: { type: 'time', axisLine: { lineStyle: { color: 'rgba(128,128,128,0.25)' } }, axisLabel: { color: 'var(--muted, #888)', fontSize: 10.5, hideOverlap: true }, splitLine: { show: false } },
      yAxis: { type: 'value', axisLabel: { color: 'var(--muted, #888)', fontSize: 10.5, formatter: (v) => fmt(v) }, splitLine: { lineStyle: { color: 'rgba(128,128,128,0.12)' } } },
      series: lines,
    };
  }, [series, metric, metrics, moments, hiddenPosts, showCampaigns, showOther, showClicks, linkClicks, perEvent, evData]); // eslint-disable-line react-hooks/exhaustive-deps -- marks derives from these
  return (
    <div style={{ ...card, marginTop: 0 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {metrics.map(([k, label]) => <Chip key={k} on={metric === k} onClick={() => setMetric(k)}>{label}</Chip>)}
        {events.length > 1 && eventSeriesLoader && (
          <Chip on={perEvent} onClick={() => setEvOpen(true)}>🎪 Events ({perEvent ? eventSel.size : 'All'}) ▾</Chip>
        )}
        <MomentToggles moments={moments} hiddenPosts={hiddenPosts} setHiddenPosts={setHiddenPosts} showCampaigns={showCampaigns} setShowCampaigns={setShowCampaigns} showOther={showOther} setShowOther={setShowOther} openPicker={() => setPickerOpen(true)} />
        {!perEvent && linkClicks.length > 0 && <Chip on={showClicks} onClick={() => setShowClicks(!showClicks)}>🔗 Link clicks ({fmt(totalClicks)})</Chip>}
      </div>
      {evErr && <div style={errBox}>{evErr}</div>}
      {perEvent && !evData && !evErr && <p style={mutedTxt}>Loading events…</p>}
      {series.length === 0
        ? <p style={sub}>No rollup data yet — run a sync (or wait for tonight's).</p>
        : <ReactECharts echarts={echarts} option={option} notMerge onEvents={{ click: momentClick(marks, setDetail) }} style={{ height: isMobile ? 200 : 260, width: '100%' }} opts={{ renderer: 'canvas' }} />}
      {pickerOpen && <PostPicker posts={moments.filter((m) => m.type === 'post')} hidden={hiddenPosts} setHidden={setHiddenPosts} onClose={() => setPickerOpen(false)} />}
      {evOpen && <EventPicker events={events} sel={eventSel} setSel={setEventSel} onClose={() => setEvOpen(false)} />}
      <MomentDetail m={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

// Today, hour by hour — live from PostHog (same 4-min cache). Swaps in for the
// daily SeriesCard when the "Today" chip is active; same one-metric-at-a-time
// chips, zero/unmapped metrics hidden.
function TodayChart({ loader, moments = [] }) {
  const isMobile = useIsMobile();
  const [out, setOut] = useState(null);
  const [error, setError] = useState('');
  const [metric, setMetric] = useState('uniques');
  const [hiddenPosts, setHiddenPosts] = useState(() => new Set());
  const [showCampaigns, setShowCampaigns] = useState(true);
  const [showOther, setShowOther] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [detail, setDetail] = useState(null);
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
  const marks = shownMoments(moments, hiddenPosts, showCampaigns, showOther);
  const option = useMemo(() => {
    const brand = brandPrimary();
    // Category axis carries the FULL hour bucket (label shows HH:MM) so moment
    // markers can address their exact hour, even across multi-day hourly ranges.
    const buckets = hours.map((h) => String(h.hour));
    const bucketSet = new Set(buckets);
    const toBucket = (m) => {
      const at = String(m.at).replace('T', ' ');
      const b = `${at.slice(0, 13)}:00:00`;
      return bucketSet.has(b) ? b : null;
    };
    return {
      animationDuration: 300,
      grid: { left: 8, right: 12, top: 12, bottom: 8, containLabel: true },
      tooltip: { trigger: 'axis', valueFormatter: (v) => (v == null ? '—' : Number(v).toLocaleString('en-ZA')), extraCssText: 'z-index: 40;' },
      xAxis: { type: 'category', data: buckets, axisLine: { lineStyle: { color: 'rgba(128,128,128,0.25)' } }, axisLabel: { color: 'var(--muted, #888)', fontSize: 10.5, hideOverlap: true, formatter: (v) => String(v).slice(11, 16) }, splitLine: { show: false } },
      yAxis: { type: 'value', axisLabel: { color: 'var(--muted, #888)', fontSize: 10.5, formatter: (v) => fmt(v) }, splitLine: { lineStyle: { color: 'rgba(128,128,128,0.12)' } } },
      series: [{
        type: 'line', showSymbol: hours.length < 3, smooth: 0.15,
        lineStyle: { width: 2, color: brand }, itemStyle: { color: brand },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: `${brand}45` }, { offset: 1, color: `${brand}05` }]) },
        data: hours.map((h) => h[metric] == null ? 0 : h[metric]),
        markLine: momentMarkLine(marks, toBucket, Math.max(0, ...hours.map((h) => h[metric] || 0))),
      }],
    };
  }, [out, metric, moments, hiddenPosts, showCampaigns, showOther]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={{ ...card, marginTop: 0 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {metrics.map(([k, label]) => <Chip key={k} on={metric === k} onClick={() => setMetric(k)}>{label}</Chip>)}
        <MomentToggles moments={moments} hiddenPosts={hiddenPosts} setHiddenPosts={setHiddenPosts} showCampaigns={showCampaigns} setShowCampaigns={setShowCampaigns} showOther={showOther} setShowOther={setShowOther} openPicker={() => setPickerOpen(true)} />
      </div>
      {pickerOpen && <PostPicker posts={moments.filter((m) => m.type === 'post')} hidden={hiddenPosts} setHidden={setHiddenPosts} onClose={() => setPickerOpen(false)} />}
      <MomentDetail m={detail} onClose={() => setDetail(null)} />
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
                <td key={k} style={td}>{fmt(r[k])}{k === 'purchases' && r.purchaseValue > 0 && <span style={{ color: 'var(--muted)' }}> · {fmtR(r.purchaseValue)}</span>}</td>
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
// (interaction_type / cta_label / surface), live-queried per chip with a short
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
      tooltip: { trigger: 'axis', valueFormatter: (v) => (v == null ? '—' : Number(v).toLocaleString('en-ZA')), extraCssText: 'z-index: 40;' },
      xAxis: { type: 'category', data: days, axisLine: { lineStyle: { color: 'rgba(128,128,128,0.25)' } }, axisLabel: { color: 'var(--muted, #888)', fontSize: 10.5, hideOverlap: true, formatter: (d) => String(d).slice(5, 16) }, splitLine: { show: false } },
      yAxis: { type: 'value', axisLabel: { color: 'var(--muted, #888)', fontSize: 10.5, formatter: (v) => fmt(v) }, splitLine: { lineStyle: { color: 'rgba(128,128,128,0.12)' } } },
      series: data.values.map((v, i) => ({
        name: v, type: 'line', showSymbol: days.length < 3, smooth: 0.15,
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

// 🛒→✅ Checkout funnel — unique people reaching each stage in the window,
// bar width relative to the FIRST stage, with step-over-step conversion and
// the end-to-end rate up top. "Reached the stage", not a strict sequence —
// honest about optional paths (cart can be skipped). Steps come from the
// mapping (metricMap.funnelSteps) so the stages stay configurable.
function FunnelCard({ loader, admin = false }) {
  const [out, setOut] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let dead = false;
    loader().then((r) => { if (!dead) setOut(r); }).catch((e) => { if (!dead) setError(e.message); });
    return () => { dead = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- loader is stable per mount (card is keyed by scope+window)
  const steps = out?.steps || [];
  const top = steps[0]?.people || 0;
  if (!admin && (error || !top)) return null; // clients: no signal, no card
  if (admin && !error && out && !steps.length) return null; // funnel unconfigured
  const last = steps[steps.length - 1]?.people || 0;
  const overall = top ? (last / top) * 100 : 0;
  const pct = (v) => (v >= 10 ? Math.round(v) : v >= 1 ? v.toFixed(1) : v.toFixed(2));
  return (
    <div style={{ ...card, marginTop: 12 }}>
      <div style={title}>🛒 Checkout funnel</div>
      <p style={sub}>{top
        ? <>How ticket browsing turns into orders — unique people reaching each stage in this window. End to end: <b>{pct(overall)}%</b> of ticket viewers confirmed an order.</>
        : 'How ticket browsing turns into orders — unique people reaching each stage in this window.'}</p>
      {error && <div style={errBox}>{error}</div>}
      {!error && !out && <p style={mutedTxt}>Loading…</p>}
      {!error && out && steps.length > 0 && top === 0 && (
        <p style={sub}>No funnel activity in this window{admin ? ' — the stages are configurable under 🧭 Event mapping → Funnel steps' : ''}.</p>
      )}
      {top > 0 && (
        <div style={{ display: 'grid', gap: 10 }}>
          {steps.map((s, i) => {
            const prev = i > 0 ? steps[i - 1].people : null;
            const conv = prev ? (s.people / prev) * 100 : null;
            return (
              <div key={s.label}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700 }}>{s.label}</span>
                  <span style={{ fontSize: 12.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmt(s.people)}</span>
                  {conv != null && <span style={{ fontSize: 11.5, color: conv < 5 ? 'var(--danger, #dc2626)' : 'var(--muted)' }}>{pct(conv)}% of previous</span>}
                </div>
                <div style={{ height: 14, borderRadius: 7, background: 'rgba(128,128,128,0.12)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: 7, background: 'var(--brand)', opacity: 0.85, width: `${Math.max(1, (s.people / top) * 100)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
      {top > 0 && <p style={{ ...mutedTxt, fontSize: 11, marginTop: 10 }}>People who reached each stage in the window (not a strict step-by-step sequence) — revenue truth stays on the dashboards.</p>}
    </div>
  );
}

// 🎯 CTA clicks by label — which buttons people actually tap (recreates the
// Looker "CTA clicks by label" tile, live + scoped to this view's window and
// client). Horizontal bars, one hue — it's ONE measure across categories; the
// long tail past the top N is a single muted "Other" bar. Clients see the card
// only once it has data; admins get the mapping pointer instead of silence.
function CtaLabelsCard({ loader, admin = false }) {
  const isMobile = useIsMobile();
  const [out, setOut] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let dead = false;
    loader().then((r) => { if (!dead) setOut(r); }).catch((e) => { if (!dead) setError(e.message); });
    return () => { dead = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- loader is stable per mount (card is keyed by scope+window)
  const items = [
    ...(out?.labels || []).map((r) => ({ ...r })),
    ...(out?.otherCount ? [{ label: `Other (${out.otherCount} more label${out.otherCount === 1 ? '' : 's'})`, clicks: out.otherClicks, uniques: null, other: true }] : []),
  ];
  if (!admin && (!items.length || error)) return null; // clients: no signal, no card
  if (admin && !error && (!out || (!items.length && !out.mapped))) return null; // pre-mapping the stat tiles already say CTA is unmapped
  const option = {
    animationDuration: 300,
    grid: { left: 8, right: 54, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' }, extraCssText: 'z-index: 40;',
      formatter: (ps) => { const it = items[ps[0]?.dataIndex]; return it ? `${it.label}<br/>${fmt(it.clicks)} clicks${it.uniques != null ? ` · ${fmt(it.uniques)} people` : ''}` : ''; },
    },
    xAxis: { type: 'value', axisLabel: { color: 'var(--muted, #888)', fontSize: 10.5, formatter: (v) => fmt(v) }, splitLine: { lineStyle: { color: 'rgba(128,128,128,0.12)' } } },
    yAxis: { type: 'category', inverse: true, data: items.map((r) => r.label), axisLine: { lineStyle: { color: 'rgba(128,128,128,0.25)' } }, axisTick: { show: false }, axisLabel: { color: 'var(--muted, #888)', fontSize: 11, width: isMobile ? 96 : 170, overflow: 'truncate' } },
    series: [{
      type: 'bar', barMaxWidth: 16,
      data: items.map((r) => ({ value: r.clicks, itemStyle: { color: r.other ? 'rgba(128,128,128,0.45)' : '#ff385c', borderRadius: [0, 4, 4, 0] } })),
      label: { show: true, position: 'right', fontSize: 11, fontWeight: 600, color: 'var(--muted, #888)', formatter: (p) => fmt(p.value) },
    }],
  };
  return (
    <div style={{ ...card, marginTop: 12 }}>
      <div style={title}>🎯 CTA clicks by label</div>
      <p style={sub}>{out?.total
        ? `${fmt(out.total)} labelled CTA taps in this window — which buttons people actually press.`
        : 'Total CTA taps in this window, broken down by button label.'}</p>
      {error && <div style={errBox}>{error}</div>}
      {!error && !out && <p style={mutedTxt}>Loading…</p>}
      {!error && out && !items.length && (
        <p style={sub}>The mapped CTA taps carry no values on <code>{out.labelProp || '(no label property set)'}</code> in this window — find where the labels live with 🔬 Diagnose's property explorer (List keys on the CTA slice), then set <b>CTA label property</b> in 🧭 Event mapping.</p>
      )}
      {!error && items.length > 0 && (
        <div style={{ width: '100%', overflow: 'hidden' }}>
          <ReactECharts echarts={echarts} option={option} notMerge style={{ height: Math.max(120, 24 + items.length * (isMobile ? 30 : 34)), width: '100%' }} opts={{ renderer: 'canvas' }} />
        </div>
      )}
    </div>
  );
}

// 🏆 Super fans — the 10 most active people in the window, its own card (moved
// out of the App-users list per Shai). Auto-loads: it's a headline metric, and
// the server caches the query.
function TopUsersCard({ loader, win }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  // TRUE fans by default — Howler staff emails are excluded until toggled in.
  const [withStaff, setWithStaff] = useState(false);
  useEffect(() => {
    let dead = false;
    setRows(null); setError('');
    loader({ orderBy: 'active', limit: 10, excludeStaff: !withStaff })
      .then((r) => { if (!dead) setRows(r.people || []); })
      .catch((e) => { if (!dead) setError(e.message); });
    return () => { dead = true; };
  }, [withStaff]); // eslint-disable-line react-hooks/exhaustive-deps -- loader is stable per mount (card is keyed by scope+window)
  if (rows && rows.length === 0 && !withStaff) return null; // no signal, no card
  const max = Math.max(1, ...(rows || []).map((p) => p.interactions || 0));
  return (
    <div style={{ ...card, marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ ...title, flex: 1, marginBottom: 0 }}>🏆 Super fans</div>
        <Chip on={!withStaff} onClick={() => setWithStaff(!withStaff)}>{withStaff ? 'Howler staff shown' : '🚫 Howler staff excluded'}</Chip>
      </div>
      <p style={sub}>Your 10 biggest super fans {win ? `between ${fmtDay(win.from)} and ${fmtDay(win.to)}` : 'in this window'} — the most active people in the app, by interactions{withStaff ? '' : ' (Howler email addresses excluded)'}.</p>
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
// 🎟 App audience vs buyers — the email join between the client's app users
// (PostHog) and their ticket buyers (Looker, hard-scoped). Counts only; the
// underlying emails never reach the browser. Renders nothing until it can
// compute (PostHog + event scope + buyers all resolvable).
function AudienceMatchCard({ entityId, scope, events = [], isMobile }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [event, setEvent] = useState(''); // '' = all the client's Pulse events
  const [segBusy, setSegBusy] = useState(''); // group key mid-create
  const [segMsg, setSegMsg] = useState(null); // { name, count, truncated } on success
  const [segErr, setSegErr] = useState('');
  useEffect(() => {
    let dead = false;
    setD(null); setErr(''); setSegMsg(null); setSegErr('');
    api.appAudience(entityId, scope, { event }).then((r) => { if (!dead) setD(r); }).catch((e) => { if (!dead) setErr(e.message); });
    return () => { dead = true; };
  }, [entityId, scope, event]);
  const makeSegment = async (group) => {
    setSegBusy(group); setSegMsg(null); setSegErr('');
    try {
      const r = await api.appAudienceSegment(entityId, scope, { group, event });
      setSegMsg({ name: r.segment?.name, count: r.count, truncated: r.truncated });
    } catch (e) { setSegErr(e.message); }
    setSegBusy('');
  };
  // "Engage them": save the never-ticket group as a segment and jump straight
  // into a new campaign with it preselected (the ?goal&segment deep link the
  // briefing suggestions already use). Admin view stays put — the campaign
  // lives in the CLIENT's Engage, so we confirm instead of navigating away.
  const navigate = useNavigate();
  const eventName = event ? (events.find((ev) => String(ev.eventRef) === String(event))?.eventName || '') : '';
  const engageThem = async () => {
    setSegBusy('engage'); setSegMsg(null); setSegErr('');
    try {
      const r = await api.appAudienceSegment(entityId, scope, { group: 'never_ticket', event });
      if (scope === 'admin-client') {
        setSegMsg({ name: r.segment?.name, count: r.count, truncated: r.truncated });
      } else {
        const goal = `Convert app fans who never got a ticket${eventName ? ` for ${eventName}` : ''} into buyers — send them a reason to grab one.`;
        vtNavigate(navigate, `/engage/campaigns?goal=${encodeURIComponent(goal)}&segment=${encodeURIComponent(r.segment?.name || '')}`);
        return; // navigating — no local state left to settle
      }
    } catch (e) { setSegErr(e.message); }
    setSegBusy('');
  };
  if (err) return <div style={{ ...card, marginTop: 12 }}><div style={title}>🎟 App audience vs your fans</div><div style={errBox}>{err}</div></div>;
  if (!d) return null;
  if (!d.configured || !d.scoped) return null;
  const pctOf = (n, base) => (base > 0 ? ` · ${Math.round((n / base) * 100)}%` : '');
  const pctPlain = (n, base) => (base > 0 ? `${Math.round((n / base) * 100)}%` : null);
  const hasAtt = d.attendees != null;
  // Two distinct segments on purpose: ATTENDEES (held a ticket — core_users) is
  // the wide "our fans" set; BUYERS (paid — core_purchasers) is the spenders.
  // The LEADING % on every match tile is the ticketing-base reading ("38% of
  // your holders use the app") — the flip line carries the app-side reading.
  const holderPct = hasAtt ? pctPlain(d.matchedAttendees, d.attendees) : null;
  const neverCount = hasAtt ? d.appNotAttendees : d.appNotBuyers;
  const tiles = [
    [`App users (${d.windowDays}d)`, d.appUsers, ''],
    ...(hasAtt ? [['Also ticket holders', d.matchedAttendees, pctOf(d.matchedAttendees, d.attendees),
      `📲 of your ${fmt(d.attendees)} holders${pctPlain(d.matchedAttendees, d.appUsersWithEmail) ? ` · ${pctPlain(d.matchedAttendees, d.appUsersWithEmail)} of app users` : ''}`]] : []),
    ['Also buyers (paid)', d.matched, pctOf(d.matched, d.buyers),
      `📲 of your ${fmt(d.buyers)} buyers${pctPlain(d.matched, d.appUsersWithEmail) ? ` · ${pctPlain(d.matched, d.appUsersWithEmail)} of app users` : ''}`],
    [hasAtt ? 'Never held a ticket' : 'Not bought yet', neverCount, pctOf(neverCount, d.appUsersWithEmail),
      '🎯 your warm retargeting audience'],
    ...(hasAtt ? [['Ticket holders not on the app', d.attendeesNotOnApp, pctOf(d.attendeesNotOnApp, d.attendees)]] : []),
    ['Buyers not on the app', d.buyersNotOnApp, pctOf(d.buyersNotOnApp, d.buyers)],
  ];
  return (
    <div style={{ ...card, marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ ...title, flex: 1, minWidth: 0, marginBottom: 0 }}>🎟 App audience vs your fans</div>
        {events.length > 1 && (
          <select value={event} onChange={(e) => setEvent(e.target.value)} style={{ ...input, width: 'auto', minWidth: 150, marginTop: 0 }}>
            <option value="">All your events</option>
            {events.map((ev) => <option key={ev.eventRef} value={ev.eventRef}>{ev.eventName || `Event ${ev.eventRef}`}</option>)}
          </select>
        )}
      </div>
      <p style={{ ...sub, marginTop: 6 }}>Your app users matched by email against two segments {event ? <b>for this event</b> : <b>for the events in your Pulse</b>}: <b>ticket holders</b> (anyone who's held a ticket) and <b>buyers</b> (who actually paid — a group buy is one buyer, many holders).</p>
      {/* The headline insight — the sentence a client repeats in a meeting —
          with the action right next to it. */}
      <div style={{ border: '1px solid var(--hairline)', borderRadius: 12, padding: '12px 14px', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: 'color-mix(in srgb, var(--brand) 6%, transparent)' }}>
        <div style={{ flex: 1, minWidth: 220, fontSize: 13.5, lineHeight: 1.55 }}>
          💡 <b>{fmt(d.appUsers)}</b> people engaged with {event ? 'this event' : 'your events'} in the app
          {holderPct ? <> · <b>{holderPct}</b> of {event ? 'its' : 'your'} ticket holders are app users</> : null}
          {neverCount > 0 ? <> · <b>{fmt(neverCount)}</b> engaged fans never got a ticket</> : null}.
        </div>
        {neverCount > 0 && (
          <button style={{ ...btn, whiteSpace: 'nowrap' }} disabled={!!segBusy} onClick={engageThem}>
            {segBusy === 'engage' ? 'Preparing…' : '📣 Engage them'}
          </button>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${isMobile ? 130 : 160}px, 1fr))`, gap: 8 }}>
        {tiles.map(([label, v, pct, flip]) => (
          <div key={label} style={{ border: '1px solid var(--hairline)', borderRadius: 12, padding: '11px 13px' }}>
            <div style={{ fontSize: 22, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
              {fmt(v)}{pct && <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--muted)' }}>{pct}</span>}
            </div>
            <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginTop: 2 }}>{label}</div>
            {flip && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, lineHeight: 1.35 }}>{flip}</div>}
          </div>
        ))}
      </div>
      {/* One click → a saved Engage segment (snapshot of the group, dated). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>🎯 Save as segment:</span>
        {[
          ['never_ticket', hasAtt ? '📲 Never held a ticket' : '📲 Not bought yet'],
          ...(hasAtt ? [['holders_not_app', '🎟 Holders not on the app']] : []),
          ['buyers_not_app', '💳 Buyers not on the app'],
          ...(hasAtt ? [['group_buy', '🎟 Held a ticket, never paid']] : []),
        ].map(([g, label]) => (
          <button key={g} style={{ ...ghostBtn, padding: '7px 12px', opacity: segBusy && segBusy !== g ? 0.5 : 1 }} disabled={!!segBusy} onClick={() => makeSegment(g)}>
            {segBusy === g ? 'Creating…' : label}
          </button>
        ))}
      </div>
      {segMsg && (
        <div style={{ fontSize: 12, marginTop: 8, color: 'var(--text)' }}>
          ✓ Segment saved — <b>{segMsg.name}</b> ({fmt(segMsg.count)} people{segMsg.truncated ? ' — the full group was larger, capped for send safety' : ''}). <a href="/engage/segments" style={{ color: 'var(--brand)', fontWeight: 700 }}>Open Segments →</a>
        </div>
      )}
      {segErr && <div style={{ ...errBox, marginTop: 8 }}>{segErr}</div>}
      <p style={{ ...mutedTxt, fontSize: 11, marginTop: 8 }}>
        Matched by email: {fmt(d.appUsersWithEmail)} of the {fmt(d.appUsers)} app users carry one{d.appCapped ? ' (top app users considered)' : ''} · {hasAtt ? `${fmt(d.attendees)} ticket holders · ` : ''}{fmt(d.buyers)} buyers — counted for {event ? 'this event' : 'these events'} only.
        {hasAtt ? ' "Holders who never paid" (the gap between the two matches) is your group-buy upgrade audience.' : ''}
        {' '}Saved segments are a snapshot of the group on the day you create them — live in <a href="/engage/segments" style={{ color: 'var(--brand)' }}>Engage → Segments</a>.
      </p>
    </div>
  );
}

function PeopleSection({ loader, win, ticketsLoader, exportUrl }) {
  const [exporting, setExporting] = useState(false);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  // email → [{event, tickets}] — the ticketing join for the emails on screen.
  const [tickets, setTickets] = useState({});
  useEffect(() => {
    if (!ticketsLoader || !rows?.length) return;
    let dead = false;
    const emails = [...new Set(rows.map((p) => String(p.email || '').toLowerCase()).filter(Boolean))].filter((e) => !(e in tickets));
    if (!emails.length) return;
    ticketsLoader(emails)
      .then((r) => { if (!dead) setTickets((t) => ({ ...Object.fromEntries(emails.map((e) => [e, []])), ...t, ...(r.byEmail || {}) })); })
      .catch(() => { /* enrichment only — the table stands without it */ });
    return () => { dead = true; };
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const ticketCell = (p) => {
    const list = tickets[String(p.email || '').toLowerCase()];
    if (!list) return '…';
    if (!list.length) return '—';
    const shown = list.slice(0, 2).map((t) => `${t.event}${t.tickets > 1 ? ` ×${t.tickets}` : ''}`).join(', ');
    return list.length > 2 ? `${shown} +${list.length - 2}` : shown;
  };
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
  // The export downloads EVERY user from the server in one file — the on-screen
  // list pages (PostHog forbids OFFSET past 2000), the export does not.
  const exportCsv = async () => {
    setExporting(true); setError('');
    try {
      const r = await fetch(exportUrl(q));
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Export failed.');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await r.blob());
      a.download = 'app-users.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setError(e.message); }
    setExporting(false);
  };
  return (
    <div style={{ ...card, marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ ...title, flex: 1, marginBottom: 0 }}>👤 App users</div>
        {exportUrl && <button type="button" style={ghostBtn} disabled={exporting} onClick={exportCsv}>{exporting ? 'Exporting…' : 'Export all (CSV)'}</button>}
      </div>
      <p style={sub}>Who's actually in the app {win ? `between ${fmtDay(win.from)} and ${fmtDay(win.to)}` : ''} — profile details (email, name, mobile) from PostHog, most recent first.</p>
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
                <thead><tr>{['Name', 'Email', 'Mobile', 'Interactions', 'Last seen', 'Events', ...(ticketsLoader ? ['🎟 Tickets'] : [])].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {rows.map((p, i) => (
                    <tr key={i}>
                      <td style={{ ...td, fontWeight: 600 }}>{[p.firstName, p.lastName].filter(Boolean).join(' ') || '—'}</td>
                      <td style={td}>{p.email || '—'}</td>
                      <td style={td}>{p.phone || '—'}</td>
                      <td style={td}>{fmt(p.interactions)}</td>
                      <td style={td}>{p.lastSeen ? new Date(p.lastSeen).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                      <td style={{ ...td, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{(p.eventNames || []).join(', ') || '—'}</td>
                      {ticketsLoader && <td style={{ ...td, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.email ? ticketCell(p) : '—'}</td>}
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
  const [catQ, setCatQ] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api.posthogSettings().then((s) => setM({
      ...s.metricMap,
      // funnel steps edit as text — `Label :: mapping entry` per line
      funnelText: (s.metricMap.funnelSteps || []).map((f) => `${f.label} :: ${f.events.join(', ')}`).join('\n'),
    })).catch(() => {});
  }, []);
  if (!m) return null;
  const listVal = (k) => (Array.isArray(m[k]) ? m[k].join('\n') : m[k] || '');
  const setList = (k, v) => setM({ ...m, [k]: v.split(/\n/) });
  const setPerson = (k, v) => setM({ ...m, personProps: { ...m.personProps, [k]: v } });
  const save = async () => {
    const funnelSteps = (m.funnelText ?? '').split('\n').map((line) => {
      const [label, ...rest] = line.split('::');
      return { label: (label || '').trim(), events: rest.join('::').split(',').map((x) => x.trim()).filter(Boolean) };
    }).filter((s) => s.label && s.events.length);
    await api.savePosthogSettings({ metricMap: { ...m, funnelSteps } });
    setSaved(true); setTimeout(() => setSaved(false), 1600);
  };
  return (
    <div style={{ ...card, marginTop: 12 }}>
      <div style={title}>🧭 Event mapping</div>
      <p style={sub}>Tell Pulse which PostHog events mean what — one entry per line. Either a plain event name, or <code>event : property=value</code> when one generic event carries several meanings (e.g. <code>interaction : interaction_type=content_view</code>). Chain conditions with <code>&amp;</code> — <code>interaction : interaction_type=content_view &amp; surface=order_success</code> is "a view of the order-confirmation screen". <code>property=*</code> means "the property is present with any value" (e.g. <code>interaction : cta_label=*</code> counts every labelled CTA tap). The catalog shows what the app actually sends, busiest first; 🔬 Diagnose shows the property keys and values.</p>
      <div style={grid2}>
        {[['screenEvents', 'Screen / page views'], ['ctaEvents', 'CTA taps'], ['purchaseEvents', 'Purchases'], ['notificationEvents', 'Notifications']].map(([k, label]) => (
          <label key={k} style={lbl}>{label}
            <textarea style={{ ...input, minHeight: 64, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} value={listVal(k)} onChange={(e) => setList(k, e.target.value)} />
          </label>
        ))}
      </div>
      <div style={grid2}>
        <label style={lbl}>Purchase value property
          <input style={input} value={m.purchaseValueProp || ''} onChange={(e) => setM({ ...m, purchaseValueProp: e.target.value })} placeholder="e.g. order_amount_cents" autoComplete="off" />
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginTop: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!m.purchaseValueCents} onChange={(e) => setM({ ...m, purchaseValueCents: e.target.checked })} />
            value is in cents (÷100 → rand)
          </span>
        </label>
        <label style={lbl}>CTA label property (the 🎯 "CTA clicks by label" chart)
          <input style={input} value={m.ctaLabelProp || ''} onChange={(e) => setM({ ...m, ctaLabelProp: e.target.value })} placeholder="e.g. cta_label" autoComplete="off" />
        </label>
        <label style={lbl}>Breakdown properties (the "What's driving it" chips)
          <textarea style={{ ...input, minHeight: 64, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} value={listVal('breakdownProps')} onChange={(e) => setList('breakdownProps', e.target.value)} placeholder={'surface\ncta_label\ninteraction_type'} />
        </label>
        <label style={{ ...lbl, gridColumn: '1 / -1' }}>Funnel steps (the 🛒 Checkout funnel) — one stage per line: <code>Label :: mapping entry</code>
          <textarea style={{ ...input, minHeight: 84, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} value={m.funnelText ?? ''} onChange={(e) => setM({ ...m, funnelText: e.target.value })}
            placeholder={'Tickets viewed :: interaction : surface=ticket_categories\nCheckout :: interaction : surface=checkout'} />
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
        <>
          {/* Low-volume events (a notification open, a rare purchase) drown below
              the busiest chips — the filter is how you actually find them. */}
          <input style={{ ...input, marginTop: 10 }} value={catQ} onChange={(e) => setCatQ(e.target.value)}
            placeholder={`Filter ${catalog.length} events… try "notif", "push", "purchase"`} autoComplete="off" />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            {catalog.filter((c) => !catQ.trim() || c.event.toLowerCase().includes(catQ.trim().toLowerCase())).slice(0, 60).map((c) => (
              <span key={c.event} style={{ fontSize: 11.5, fontFamily: 'ui-monospace, monospace', border: '1px solid var(--hairline)', borderRadius: 6, padding: '3px 8px' }}>
                {c.event} <span style={{ color: 'var(--muted)' }}>· {fmt(c.count)}</span>
              </span>
            ))}
            {catQ.trim() && !catalog.some((c) => c.event.toLowerCase().includes(catQ.trim().toLowerCase())) && (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>No event matches "{catQ.trim()}" — the app may track it as a property value instead; try the 🔬 Diagnose property explorer below (e.g. event <code>interaction</code>, key <code>interaction_type</code>).</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// 🛒 One-tap answer to "does the app track orders / payments?" — sweeps a year
// of event names + mapped property values for commerce-ish terms server-side.
// Findings land as ranked tables; an empty sweep gets an honest verdict (order
// truth lives in Looker; the app only records intent taps).
function CommerceScanCard() {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setBusy(true); setError('');
    try { setD(await api.posthogCommerceScan()); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const Tbl = ({ head, rows }) => (
    <div style={{ overflowX: 'auto', marginBottom: 10 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 480 }}>
        <thead><tr>{head.map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
  const seen = (r) => `${String(r.firstSeen).slice(0, 10)} → ${String(r.lastSeen).slice(0, 10)}`;
  return (
    <div style={{ ...card, marginTop: 12 }}>
      <div style={title}>🛒 Order & payment signals</div>
      <p style={sub}>Does the app send any order / purchase / payment / checkout data to PostHog? One tap sweeps a full year of event names and the mapped property values for commerce terms and shows everything it finds, with first/last-seen dates.</p>
      {!d && <button type="button" style={btn} disabled={busy} onClick={run}>{busy ? 'Scanning…' : 'Scan for order data'}</button>}
      {error && <div style={errBox}>{error}</div>}
      {d && (
        <>
          {d.events.length > 0 && (
            <>
              <div style={{ ...title, fontSize: 12.5 }}>Matching events</div>
              <Tbl head={['Event', 'Count (1y)', 'Seen']} rows={d.events.map((r) => (
                <tr key={r.event}><td style={{ ...td, fontFamily: 'ui-monospace, monospace', fontWeight: 600 }}>{r.event}</td><td style={td}>{fmt(r.count)}</td><td style={td}>{seen(r)}</td></tr>
              ))} />
            </>
          )}
          {d.values.length > 0 && (
            <>
              <div style={{ ...title, fontSize: 12.5 }}>Matching property values</div>
              <Tbl head={['Property', 'Value', 'Count (1y)', 'Seen']} rows={d.values.map((r, i) => (
                <tr key={i}><td style={{ ...td, color: 'var(--muted)' }}>{r.key}</td><td style={{ ...td, fontFamily: 'ui-monospace, monospace', fontWeight: 600 }}>{r.value}</td><td style={td}>{fmt(r.count)}</td><td style={td}>{seen(r)}</td></tr>
              ))} />
            </>
          )}
          {d.events.length === 0 && d.values.length === 0 && (
            <p style={sub}>Nothing order/payment-ish exists in the app's PostHog data (searched: {d.terms.join(', ')}). The app records purchase <i>intent</i> (CTA taps like <code>buy_tickets</code>, <code>pay_now</code>) but not completed orders — order, payment and revenue truth lives in the Looker-powered dashboards.</p>
          )}
          <button type="button" style={ghostBtn} disabled={busy} onClick={run}>{busy ? 'Scanning…' : 'Re-scan'}</button>
        </>
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
          <HistoryHunt />
          <ValueExplorer />
          <button type="button" style={ghostBtn} disabled={busy} onClick={run}>{busy ? 'Checking…' : 'Re-run'}</button>
        </>
      )}
    </div>
  );
}

// Does something exist ANYWHERE in the data? Sweeps a full year of event names
// AND breakdown-property values for a term (e.g. "notif"), with first/last seen —
// settles "I'm sure we track this" definitively, including things that stopped.
function HistoryHunt() {
  const [q, setQ] = useState('notif');
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async (e) => {
    e?.preventDefault();
    if (!q.trim()) return;
    setBusy(true); setError('');
    try { setOut(await api.posthogSearchEvents(q.trim())); } catch (err) { setError(err.message); }
    setBusy(false);
  };
  const when = (r) => `${String(r.firstSeen).slice(0, 10)} → ${String(r.lastSeen).slice(0, 10)}`;
  return (
    <div style={{ border: '1px dashed var(--hairline)', borderRadius: 10, padding: 12, margin: '4px 0 12px' }}>
      <div style={{ ...title, fontSize: 12.5 }}>Search a full year of history</div>
      <p style={{ ...sub, marginBottom: 8 }}>Looks for the term in event names AND in the breakdown properties' values — with first/last seen, so events that stopped firing still show.</p>
      <form style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} onSubmit={go}>
        <input style={{ ...input, flex: 1, minWidth: 140, marginTop: 0 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. notif, push, receive" />
        <button type="submit" style={ghostBtn} disabled={busy || !q.trim()}>{busy ? 'Searching…' : 'Search history'}</button>
      </form>
      {error && <div style={{ ...errBox, marginTop: 8 }}>{error}</div>}
      {out && out.events.length === 0 && out.values.length === 0 && (
        <p style={{ ...sub, marginTop: 8 }}>Nothing matching "{out.q}" in the last 365 days — not as an event name, not as a value of the breakdown properties. If it's tracked, it's under a different word (try another term) or a property Pulse isn't grouping by yet.</p>
      )}
      {out && (out.events.length > 0 || out.values.length > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 }}>
          {out.events.map((r) => (
            <div key={r.event} style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 600 }}>{r.event}</span>
              <span style={{ color: 'var(--muted)' }}>event · {fmt(r.count)} · {when(r)}</span>
            </div>
          ))}
          {out.values.map((r) => (
            <div key={`${r.key}:${r.value}`} style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 600 }}>{r.key}={r.value}</span>
              <span style={{ color: 'var(--muted)' }}>property value · {fmt(r.count)} · {when(r)}</span>
            </div>
          ))}
        </div>
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
    let ev = event.trim();
    if (!ev) return;
    // Forgiving input: "interaction_type=cta_click" without an event means the
    // slice form minus its event — everything rides the generic `interaction`
    // event in this app, so prefix it and show the corrected slice in the field.
    if (ev.includes('=') && !ev.includes(':')) { ev = `interaction : ${ev}`; setEvent(ev); }
    setBusy(true); setError('');
    try { setOut(await api.posthogPropertyValues(ev, key.trim())); } catch (err) { setError(err.message); }
    setBusy(false);
  };
  return (
    <div style={{ border: '1px dashed var(--hairline)', borderRadius: 10, padding: 12, margin: '4px 0 12px' }}>
      <div style={{ ...title, fontSize: 12.5 }}>Explore an event's properties</div>
      <p style={{ ...sub, marginBottom: 8 }}>Leave the property BLANK to list the keys this event actually carries. The event accepts a slice too — e.g. <code>interaction : interaction_type=cta_click</code> to see what rides only on CTA taps.</p>
      <form style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} onSubmit={go}>
        <input style={{ ...input, flex: 1.4, minWidth: 160, marginTop: 0 }} value={event} onChange={(e) => setEvent(e.target.value)} placeholder="event or slice, e.g. interaction : interaction_type=cta_click" />
        <input style={{ ...input, flex: 1, minWidth: 120, marginTop: 0 }} value={key} onChange={(e) => setKey(e.target.value)} placeholder="property (blank = list keys)" />
        <button type="submit" style={ghostBtn} disabled={busy || !event.trim()}>{busy ? '…' : key.trim() ? 'Show values' : 'List keys'}</button>
      </form>
      {error && <div style={{ ...errBox, marginTop: 8 }}>{error}</div>}
      {out && out.keys && (
        out.keys.length === 0
          ? <p style={{ ...sub, marginTop: 8 }}>No properties found on "{out.event}" in the last 30 days.</p>
          : (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
              {out.keys.map((k) => (
                <button type="button" key={k.key} onClick={() => setKey(k.key)} title="Use as the property key"
                  style={{ fontSize: 11.5, fontFamily: 'ui-monospace, monospace', border: '1px solid var(--hairline)', borderRadius: 6, padding: '3px 8px', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>
                  {k.key} <span style={{ color: 'var(--muted)' }}>· {fmt(k.count)}</span>
                </button>
              ))}
            </div>
          )
      )}
      {out && out.values && (
        out.values.length === 0
          ? <p style={{ ...sub, marginTop: 8 }}>No values for "{out.key}" on "{out.event}" in the last 30 days — clear the property field and List keys to see what this event really carries.</p>
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

// Admin Owl-summary scope: the whole app in one go, or a hand-picked set of
// clients (their event ids are unioned server-side).
function OwlScopePicker({ clients, onPick, onClose }) {
  const [picked, setPicked] = useState(() => new Set());
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const names = clients.filter((c) => picked.has(c.id)).map((c) => c.name);
  return (
    <div style={overlay} onClick={onClose}>
      <div style={{ ...modal, maxWidth: 420, maxHeight: '70vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...title, marginBottom: 2 }}>✨ Summarise what?</div>
        <p style={{ ...sub, marginBottom: 10 }}>The whole app across every client, or a set of clients you pick.</p>
        <button type="button" style={{ ...btn, marginBottom: 10 }} onClick={() => onPick({ ids: null, label: 'All clients — whole app' })}>🌍 Whole app — all clients</button>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, borderTop: '1px solid var(--hairline)', paddingTop: 8 }}>
          {clients.map((c) => (
            <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, minHeight: 36, cursor: 'pointer' }}>
              <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
          <button type="button" style={ghostBtn} onClick={onClose}>Cancel</button>
          <button type="button" style={btn} disabled={!picked.size}
            onClick={() => onPick({ ids: [...picked], label: names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ') })}>
            Summarise {picked.size || ''} client{picked.size === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Icon-only Owl summary trigger — the SAME AiMark the dashboard summaries use.
function OwlBtn({ onClick }) {
  return (
    <button type="button" onClick={onClick} title="Owl summary" aria-label="Owl summary"
      style={{ minHeight: 32, minWidth: 44, padding: '4px 12px', borderRadius: 980, border: '1px solid var(--hairline)', background: 'transparent', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      <AiMark size={18} />
    </button>
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
const overlay = { position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const modal = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 16, padding: 18, width: '100%', maxWidth: 340, boxShadow: '0 24px 60px -24px rgba(0,0,0,0.45)' };
const td = { padding: '8px', borderBottom: '1px solid var(--hairline)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
