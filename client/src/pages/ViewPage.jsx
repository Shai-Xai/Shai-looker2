import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useParams, Link, useNavigate, useOutletContext } from 'react-router-dom';
import { vtNavigate } from '../lib/viewTransition.js';
import { PinProvider } from '../lib/PinContext.jsx';
import FilterBar, { activeFilterCount } from '../components/FilterBar.jsx';
import DashboardInsightModal from '../components/DashboardInsightModal.jsx';
import AiMark from '../components/AiMark.jsx';
import EditableGrid from '../components/EditableGrid.jsx';
import { api } from '../lib/api.js';
import { ANY_VALUE } from '../lib/filterConstants.js';
import { useAuth } from '../lib/auth.jsx';
import { useTheme } from '../lib/theme.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { ScopeProvider } from '../lib/ScopeContext.jsx';

// Read-only render of a saved dashboard. When opened inside a Suite
// (/suite/:suiteId/d/:id) the suite's locked filters are pre-filled + locked and
// every query is scoped to that suite. Admins opening /d/:id directly are unscoped.
export default function ViewPage() {
  const isMobile = useIsMobile();
  const { id, suiteId } = useParams();
  const navigate = useNavigate();
  const { isAdmin, insightsEnabled, user } = useAuth();
  const { previewEntityId, actionsSlot } = useOutletContext() || {};
  const { theme: appTheme } = useTheme();
  const [def, setDef] = useState(null);
  const [setInfo, setSetInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filterValues, setFilterValues] = useState({});
  // Entity for tile-level actions (create segment). The suite's own entity is
  // authoritative (works for admin-preview AND client); fall back to the preview
  // entity, then the client's own entity. setInfo is the loaded suite.
  const scopeEntityId = setInfo?.entityId || previewEntityId || (isAdmin ? null : ((user?.entities || [])[0]?.id || (user?.entityIds || [])[0] || null));
  const [locked, setLocked] = useState({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [entityDefault, setEntityDefault] = useState(null); // the client default (if any), for reset
  const [hasUserView, setHasUserView] = useState(false);    // does this user have a saved view?
  const [viewStatus, setViewStatus] = useState('');         // transient "Saved ✓" feedback
  const [daysToGo, setDaysToGo] = useState(null);           // live days-before-event (from the source tile)
  const [refreshKey, setRefreshKey] = useState(0);          // bump → all tiles re-fetch live (cache-bypassing)
  const refreshNow = () => setRefreshKey((k) => k + 1);
  const [softKey, setSoftKey] = useState(0);                // bump → silent, cache-friendly re-fetch (focus/interval)

  // Build filter values from the dashboard defaults + suite locks, with an
  // optional saved overlay (entity default then the user's view). Locks always
  // win; a shared link (?f=) overrides any non-locked filter last.
  function buildFilters(data, suite, overlay) {
    const lockMap = suite?.lockedFilters || {};
    const norm = {};
    for (const [k, v] of Object.entries(lockMap)) norm[k.trim().toLowerCase()] = v;
    const vals = {};
    const lockedMap = {};
    for (const f of data.filters || []) {
      vals[f.name] = f.default_value || '';
      const field = (f.field || f.dimension || '').trim().toLowerCase();
      const nameKey = (f.name || '').trim().toLowerCase();
      const v = norm[nameKey] != null ? norm[nameKey] : (field ? norm[field] : undefined);
      if (v != null && v !== '') { vals[f.name] = v; lockedMap[f.name] = true; }
    }
    if (overlay) for (const [k, v] of Object.entries(overlay)) { if (k in vals && !lockedMap[k] && typeof v === 'string') vals[k] = v; }
    try {
      const f = new URLSearchParams(window.location.search).get('f');
      if (f) { const shared = JSON.parse(decodeURIComponent(f)); for (const [k, v] of Object.entries(shared || {})) if (k in vals && !lockedMap[k] && typeof v === 'string') vals[k] = v; }
    } catch { /* malformed share param — ignore */ }
    return { vals, lockedMap };
  }

  useEffect(() => {
    setLoading(true);
    setError(null);
    setDaysToGo(null);
    const suiteP = suiteId ? api.mySuite(suiteId).catch(() => null) : Promise.resolve(null);
    // Saved views: a user's "save my view" beats the client default beats the
    // dashboard's own default_value. Failure is non-fatal — fall back to defaults.
    const savedP = api.getDashboardFilters(id, suiteId).catch(() => ({ user: null, entityDefault: null }));
    Promise.all([api.getDashboard(id), suiteP, savedP])
      .then(([data, suite, saved]) => {
        setDef(data);
        setSetInfo(suite);
        setEntityDefault(saved?.entityDefault || null);
        setHasUserView(!!saved?.user);
        const overlay = { ...(saved?.entityDefault || {}), ...(saved?.user || {}) }; // user wins
        const { vals, lockedMap } = buildFilters(data, suite, overlay);
        setFilterValues(vals);
        setLocked(lockedMap);
        applyDaysToGo(data, vals); // live "days to go" + optional auto-apply (non-blocking)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, suiteId]);

  // Read the current days-before-event number live from the configured source
  // tile, surface it as "N days to go", and (in apply mode) set the days-before
  // filter so YoY tiles align to today's point in the cycle. Non-blocking.
  async function applyDaysToGo(data, baseVals) {
    const sync = data.daysBeforeSync;
    if (!sync || sync.mode === 'off' || !sync.sourceTileId) return;
    const tiles = [...(data.tiles || []), ...((data.carousels || []).flatMap((c) => c.tiles || []))];
    const src = tiles.find((t) => t.id === sync.sourceTileId);
    if (!src?.query) return;
    const overrides = {};
    for (const [fname, qfield] of Object.entries(src.listenTo || {})) {
      const v = baseVals[fname];
      if (v === ANY_VALUE) overrides[qfield] = ANY_VALUE;
      else if (v && String(v).trim()) overrides[qfield] = String(v).trim();
    }
    try {
      const res = await api.runQuery(src.query, overrides, undefined, suiteId);
      const n = firstNumber(res);
      if (n == null) return;
      setDaysToGo(n);
      if (sync.mode === 'apply' && sync.filterName) {
        const expr = String(sync.expr || '>={n}').replace('{n}', String(n));
        setFilterValues((p) => ({ ...p, [sync.filterName]: expr }));
      }
    } catch { /* leave days-to-go hidden on failure */ }
  }

  const handleFilterChange = useCallback((name, value) => {
    setFilterValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  // Keep an open dashboard current: soft-refresh when the tab regains focus and
  // on a light interval (data moves on a ~30-min pipeline). Silent + cache-
  // friendly — no skeleton flash, no forced Looker hits (the cache serves it).
  useEffect(() => {
    const soft = () => { if (document.visibilityState === 'visible') setSoftKey((k) => k + 1); };
    document.addEventListener('visibilitychange', soft);
    window.addEventListener('focus', soft);
    const iv = setInterval(soft, 5 * 60 * 1000);
    return () => { document.removeEventListener('visibilitychange', soft); window.removeEventListener('focus', soft); clearInterval(iv); };
  }, []);

  // Saved filter views. We persist only non-locked values (locks are enforced on
  // load anyway). A flash gives quick "Saved ✓" feedback.
  const flashView = (msg) => { setViewStatus(msg); setTimeout(() => setViewStatus(''), 1800); };
  const savableFilters = () => Object.fromEntries(Object.entries(filterValues).filter(([k]) => !locked[k]));
  const saveMyView = async () => { try { await api.saveMyDashboardFilters(id, savableFilters()); setHasUserView(true); flashView('Saved ✓'); } catch { flashView('Could not save'); } };
  const resetMyView = async () => {
    try { await api.resetMyDashboardFilters(id); } catch { /* ignore */ }
    setHasUserView(false);
    const { vals, lockedMap } = buildFilters(def, setInfo, entityDefault || {});
    setFilterValues(vals); setLocked(lockedMap); flashView('Reset to default');
  };
  const setClientDefault = async () => {
    if (!scopeEntityId) { flashView('No client in context'); return; }
    try { const f = savableFilters(); await api.setClientDashboardFilters(scopeEntityId, id, f); setEntityDefault(f); flashView('Set as client default ✓'); } catch (e) { flashView('Could not set default'); }
  };
  const viewActions = { onSave: saveMyView, onReset: resetMyView, hasSaved: hasUserView, canSetDefault: isAdmin, onSetDefault: setClientDefault, status: viewStatus };

  // View tracking (fire-and-forget) — powers home-page personalisation.
  useEffect(() => { if (suiteId && id) api.track(suiteId, id); }, [suiteId, id]);

  // Sub-dashboard tabs: if this dashboard is a parent with children — or one of
  // the children — surface the whole family as a tab bar (parent first).
  // Computed from the suite tree (setInfo + id), independent of `def`, so the
  // hooks below stay above the early returns (rules of hooks).
  let family = null;
  if (setInfo && id) {
    outer: for (const set of setInfo.sets || []) {
      for (const d of set.dashboards || []) {
        const kids = d.children || [];
        if ((d.id === id && kids.length) || kids.some((c) => c.id === id)) {
          family = [{ id: d.id, title: d.title }, ...kids.map((c) => ({ id: c.id, title: c.title }))];
          break outer;
        }
      }
    }
  }
  const curIdx = family ? family.findIndex((t) => t.id === id) : -1;
  const lastIdxRef = useRef(curIdx);
  let swipeDir = 0; // direction of the last tab change, for the slide animation
  if (family && lastIdxRef.current >= 0 && curIdx >= 0 && curIdx !== lastIdxRef.current) {
    swipeDir = curIdx > lastIdxRef.current ? 1 : -1;
  }
  useEffect(() => { lastIdxRef.current = curIdx; }, [curIdx]);
  const touch = useRef(null);
  const goToTab = (delta) => {
    if (!family || curIdx < 0) return;
    const next = family[curIdx + delta];
    if (next) navigate(`/suite/${suiteId}/d/${next.id}`);
  };
  // Touch swipe: a predominantly-horizontal flick moves to the adjacent tab.
  const onTouchStart = (e) => { if (family && e.touches.length === 1) { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY, at: Date.now() }; } };
  const onTouchEnd = (e) => {
    if (!touch.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.current.x, dy = t.clientY - touch.current.y, dt = Date.now() - touch.current.at;
    touch.current = null;
    if (dt < 600 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.8) goToTab(dx < 0 ? 1 : -1);
  };
  const swapClass = swipeDir > 0 ? 'tab-swap tab-swap-next' : swipeDir < 0 ? 'tab-swap tab-swap-prev' : 'tab-swap';

  // Full-page loader only on the very first load. When switching between
  // sibling tabs we already have a def, so keep the header + tab bar mounted
  // and just swap the content (see the dimmed grid below).
  if (loading && !def) return <Centered>Loading dashboard…</Centered>;
  if (error) return <Centered error>Error: {error}</Centered>;
  if (!def) return null;

  const theme = def.theme || {};
  // In dark mode the global theme wins: ignore the dashboard's own (light)
  // background/tile colours (otherwise tiles stay white with invisible text).
  // We OMIT --tile-bg so tiles inherit the global dark token rather than
  // self-referencing it.
  const dark = appTheme === 'dark';
  const shellStyle = {
    display: 'flex', flexDirection: 'column', flex: 1,
    background: dark ? 'var(--bg)' : (theme.background || 'var(--bg)'),
    ...(dark ? null : { '--tile-bg': theme.tileBackground || '#fff' }),
  };
  const backTo = '/';
  const hasFilters = (def.filters?.length || 0) > 0;
  const activeCount = hasFilters ? activeFilterCount(def.filters, filterValues) : 0;
  const hasTiles = !!(def.tiles?.length || def.carousels?.length);
  const canSummarize = insightsEnabled && hasTiles;

  // Header shows the active tab's title instantly on tab switch (from the
  // stable suite tree), so it doesn't lag behind the dashboard fetch.
  const headerTitle = (family && family.find((t) => t.id === id)?.title) || def.title;

  // Pin-to-home is available inside a suite when AI is on; admins previewing a
  // client pin entity-wide defaults (needs the previewed entity).
  const pinsEnabled = !!suiteId && insightsEnabled && (!isAdmin || !!previewEntityId);

  return (
    <ScopeProvider suiteId={suiteId || null} dashboardContext={def.aiContext || ''} entityId={scopeEntityId} dashboardId={id} refreshKey={refreshKey} softKey={softKey}>
    <PinProvider dashboardId={id} entityId={previewEntityId || null} isAdmin={isAdmin} enabled={pinsEnabled}>
      <div style={shellStyle}>
        {/* On mobile inside a suite the sticky "☰ Menu" bar already shows the
            context, so skip this header to avoid stacking two titles. */}
        {!(isMobile && suiteId) && (
          <div style={{ background: 'var(--frost)', backdropFilter: 'saturate(180%) blur(20px)', WebkitBackdropFilter: 'saturate(180%) blur(20px)', borderBottom: '1px solid var(--hairline)', padding: isMobile ? '12px 14px' : '16px 22px', display: 'flex', alignItems: 'center', gap: isMobile ? 10 : 16 }}>
            <Link to={backTo} title="Home" aria-label="Home" className="btn-key" style={homeBtn}><HomeIcon /></Link>
            <div style={{ flex: 1, minWidth: 0 }}>
              {(setInfo || daysToGo != null) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {setInfo && <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>{setInfo.name}</span>}
                  {daysToGo != null && <span style={daysChip}>⏳ {daysToGoLabel(daysToGo)}</span>}
                </div>
              )}
              <h2 style={{ fontSize: isMobile ? 17 : 21, fontWeight: 600, letterSpacing: '-0.02em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{headerTitle}</h2>
            </div>
            {hasTiles && !isMobile && (
              <button className="btn-key no-print" style={summaryBtn} onClick={refreshNow} title="Refresh — pull the latest data now (bypasses cache)" aria-label="Refresh data">↻ Refresh</button>
            )}
            {canSummarize && !isMobile && (
              <button className="btn-key no-print" style={summaryBtn} onClick={() => setSummaryOpen(true)} title="AI summary of the whole dashboard"><AiMark size={20} /> Summary</button>
            )}
            {hasFilters && !isMobile && (
              <button style={filtersBtn(filtersOpen)} onClick={() => setFiltersOpen(v => !v)} title="Filters" aria-label="Filters">
                {/* Icon-only trigger — a funnel + chevron. The funnel tints to the
                    brand colour when filters are active (no number, just cleaner). */}
                <span style={{ color: activeCount > 0 ? 'var(--brand)' : 'inherit', fontSize: 15 }}>⚲</span>
                <span style={{ fontSize: 11, opacity: 0.7 }}>{filtersOpen ? '▴' : '▾'}</span>
              </button>
            )}
            {!isMobile && <ActionsMenu suiteId={suiteId} dashboardId={id} filterValues={filterValues} />}
            {isAdmin && !isMobile && <button style={editBtn} onClick={() => navigate(`/d/${id}/edit`)}>Edit</button>}
          </div>
        )}

        {/* Sub-dashboard tab bar (parent + its tabs). Plain navigate (no
            whole-page transition) so only the content area swaps — the header
            and this bar stay put. */}
        {family && (
          <SubTabs
            tabs={family}
            activeId={id}
            isMobile={isMobile}
            onSelect={(tid) => navigate(`/suite/${suiteId}/d/${tid}`)}
          />
        )}

        {/* On mobile inside a suite, the dashboard actions live in the ☰ Menu
            bar (same line) — portalled there, desktop order: Summary · Filters · ⋯ */}
        {isMobile && suiteId && actionsSlot && createPortal(
          <>
            {canSummarize && (
              <button className="btn-key" style={iconAction} onClick={() => setSummaryOpen(true)} title="AI summary" aria-label="AI summary"><AiMark size={20} /></button>
            )}
            {/* Filters now live inside the ⋯ menu alongside Share / Download PDF. */}
            <ActionsMenu suiteId={suiteId} dashboardId={id} filterValues={filterValues} hasFilters={hasFilters} activeCount={activeCount} onFilters={() => setFiltersOpen(true)} onRefresh={refreshNow} />
          </>,
          actionsSlot
        )}

        {hasFilters && (
          <FilterBar
            filters={def.filters} values={filterValues} onChange={handleFilterChange} locked={locked}
            open={filtersOpen} onClose={() => setFiltersOpen(false)} viewActions={viewActions}
          />
        )}

        <div
          style={{ flex: 1, padding: isMobile ? '12px' : '22px', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}
          onTouchStart={family ? onTouchStart : undefined}
          onTouchEnd={family ? onTouchEnd : undefined}
        >
          {/* Keyed by dashboard id so the grid animates in on each tab switch
              (sliding in the swipe/click direction); dimmed while the next
              dashboard's definition loads. */}
          {/* Above the grid only when the header is hidden (mobile inside a
              suite) — otherwise it lives in the header next to the event name. */}
          {daysToGo != null && isMobile && suiteId && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 12, padding: '5px 12px', borderRadius: 980, background: 'rgba(var(--brand-rgb), 0.12)', color: 'var(--brand)', fontSize: 13, fontWeight: 700 }}>
              ⏳ {daysToGoLabel(daysToGo)}
            </div>
          )}
          <div key={id} className={swapClass} style={{ opacity: loading ? 0.45 : 1, transition: 'opacity .18s ease', pointerEvents: loading ? 'none' : 'auto' }}>
            {def.tiles?.length || def.carousels?.length ? (
              <EditableGrid tiles={def.tiles || []} carousels={def.carousels || []} filterValues={filterValues} editable={false} />
            ) : (
              <Centered>This dashboard has no tiles yet.</Centered>
            )}
          </div>
        </div>
        {summaryOpen && (
          <DashboardInsightModal
            dashboardId={id}
            title={def.title}
            filterValues={filterValues}
            suiteId={suiteId || null}
            onClose={() => setSummaryOpen(false)}
          />
        )}
      </div>
    </PinProvider>
    </ScopeProvider>
  );
}

const editBtn = { padding: '8px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer', boxShadow: '0 1px 2px rgba(128,128,128,0.2)' };
const filtersBtn = (active) => ({ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '8px 12px', background: active ? 'rgba(128,128,128,0.2)' : 'rgba(128,128,128,0.15)', color: 'var(--text)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' });
const countBadge = { background: 'var(--brand)', color: '#fff', fontSize: 11, fontWeight: 700, borderRadius: 980, minWidth: 18, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px' };
const summaryBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'rgba(128,128,128,0.15)', color: 'var(--text)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
// Compact circular action for the mobile menu bar (Summary / Filters / ⋯).
const iconAction = { position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 34, height: 34, padding: '0 8px', background: 'rgba(128,128,128,0.15)', color: 'var(--text)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0 };
const homeBtn = { flexShrink: 0, width: 34, height: 34, borderRadius: '50%', background: 'rgba(128,128,128,0.15)', color: 'var(--text)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' };

function HomeIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h5.5v-6h3v6H19V9.5" />
    </svg>
  );
}

// "⋯" actions menu next to Filters: Share (mint short link with current
// filters, copy, flash ✓) and Download PDF (print stylesheet does the rest).
// A share link is never an auth bypass — recipients log in; scoping applies.
function ActionsMenu({ suiteId, dashboardId, filterValues, hasFilters, activeCount = 0, onFilters, onRefresh }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const [shareState, setShareState] = useState('idle'); // idle | busy | copied | err
  // The frosted header (backdrop-filter) forms its own stacking context, so an
  // in-place dropdown paints BEHIND the tiles. Portal the panel to <body>,
  // fixed-positioned against the button.
  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      // Prefer aligning the panel's right edge to the button, but clamp fully
      // inside the viewport — on mobile the button sits on the LEFT, where a
      // right-anchored panel would run off-screen.
      const width = Math.min(260, window.innerWidth - 16);
      const left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8);
      setPos({ top: r.bottom + 7, left, width });
    }
    setOpen((v) => !v);
  };
  async function share() {
    setShareState('busy');
    try {
      const { path } = await api.createShareLink({ suiteId, dashboardId, filters: filterValues });
      const url = `${window.location.origin}${path}`;
      try { await navigator.clipboard.writeText(url); } catch { window.prompt('Copy this link:', url); }
      setShareState('copied');
      setTimeout(() => { setShareState('idle'); setOpen(false); }, 1600);
    } catch {
      setShareState('err');
      setTimeout(() => setShareState('idle'), 2200);
    }
  }
  return (
    <div className="no-print" style={{ flexShrink: 0 }}>
      <button ref={btnRef} style={{ ...summaryBtn, padding: '8px 13px' }} onClick={toggle} title="Actions" aria-label="Dashboard actions">⋯</button>
      {open && pos && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 398 }} onClick={() => setOpen(false)} />
          <div className="modal-in" style={{ ...actionsPanel, top: pos.top, left: pos.left, width: pos.width }}>
            {onRefresh && (
              <button style={actionItem} onClick={() => { setOpen(false); onRefresh(); }}>
                <span style={actionIco}>↻</span>
                <span style={{ flex: 1, textAlign: 'left' }}>
                  Refresh
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', fontWeight: 500 }}>Pull the latest data now</span>
                </span>
              </button>
            )}
            {hasFilters && onFilters && (
              <button style={actionItem} onClick={() => { setOpen(false); onFilters(); }}>
                <span style={{ ...actionIco, color: activeCount > 0 ? 'var(--brand)' : undefined }}>⚲</span>
                <span style={{ flex: 1, textAlign: 'left' }}>
                  Filters{activeCount > 0 ? ` · ${activeCount} active` : ''}
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', fontWeight: 500 }}>Refine what this dashboard shows</span>
                </span>
              </button>
            )}
            <button style={actionItem} onClick={share} disabled={shareState === 'busy'}>
              <span style={actionIco}>{shareState === 'copied' ? '✓' : '↗'}</span>
              <span style={{ flex: 1, textAlign: 'left' }}>
                {shareState === 'copied' ? 'Link copied' : shareState === 'err' ? 'Failed — try again' : shareState === 'busy' ? 'Creating link…' : 'Share'}
                <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', fontWeight: 500 }}>Copy a link with your current filters</span>
              </span>
            </button>
            <button style={actionItem} onClick={() => { setOpen(false); setTimeout(() => window.print(), 150); }}>
              <span style={actionIco}>⤓</span>
              <span style={{ flex: 1, textAlign: 'left' }}>
                Download PDF
                <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', fontWeight: 500 }}>Print-ready copy of this view</span>
              </span>
            </button>
          </div>
        </>,
        document.body
      )}
    </div>
  );
}
const actionsPanel = { position: 'fixed', zIndex: 399, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 13, boxShadow: 'var(--shadow-pop)', padding: 6, display: 'flex', flexDirection: 'column', gap: 2 };
const actionItem = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', padding: '9px 11px', borderRadius: 9, fontSize: 13.5, fontWeight: 600, color: 'var(--text)' };
const actionIco = { flexShrink: 0, width: 20, textAlign: 'center', fontSize: 15 };

// Underline tab bar for a parent dashboard and its sub-dashboards. The
// gradient underline is a single element measured against the active tab so it
// slides between tabs (same pattern as the sidebar's nav indicator).
function SubTabs({ tabs, activeId, onSelect, isMobile }) {
  const wrapRef = useRef(null);
  const [u, setU] = useState({ left: 0, width: 0, show: false });
  useLayoutEffect(() => {
    const el = wrapRef.current?.querySelector('[data-active="1"]');
    if (!el) { setU((s) => ({ ...s, show: false })); return; }
    setU({ left: el.offsetLeft + 10, width: Math.max(0, el.offsetWidth - 20), show: true });
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeId, tabs]);
  return (
    <div className="subtabs" ref={wrapRef} style={{ padding: isMobile ? '0 8px' : '0 14px' }}>
      {tabs.map((t) => (
        <button
          key={t.id}
          data-active={t.id === activeId ? '1' : undefined}
          className={`subtab${t.id === activeId ? ' active' : ''}`}
          onClick={() => { if (t.id !== activeId) onSelect(t.id); }}
        >
          {t.title}
        </button>
      ))}
      <span className="subtab-underline" style={{ transform: `translateX(${u.left}px)`, width: u.width, opacity: u.show ? 1 : 0 }} />
    </div>
  );
}

// Natural-language days-to-go, sign-aware (positive = upcoming, negative = past).
function daysToGoLabel(n) {
  if (n > 0) return `${n} ${n === 1 ? 'day' : 'days'} to go`;
  if (n === 0) return 'Today';
  const a = Math.abs(n);
  return `${a} ${a === 1 ? 'day' : 'days'} ago`;
}
const daysChip = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px', borderRadius: 980, background: 'rgba(var(--brand-rgb), 0.12)', color: 'var(--brand)', fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap' };

// First numeric value in a json_detail result — the days-before-event number
// from the source tile (single-value tiles surface it as the lone measure).
function firstNumber(res) {
  const row = res?.data?.[0];
  if (!row) return null;
  const fields = [...(res.fields?.measures || []), ...(res.fields?.table_calculations || []), ...(res.fields?.dimensions || [])];
  for (const f of fields) {
    const v = row[f.name]?.value;
    if (v != null && v !== '' && !Number.isNaN(Number(v))) return Math.round(Number(v));
  }
  return null;
}

function Centered({ children, error }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
      <p style={{ fontSize: 15, color: error ? 'var(--error)' : 'var(--muted)' }}>{children}</p>
    </div>
  );
}
