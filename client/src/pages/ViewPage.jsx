import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { useParams, Link, useNavigate, useOutletContext } from 'react-router-dom';
import { vtNavigate } from '../lib/viewTransition.js';
import { PinProvider } from '../lib/PinContext.jsx';
import FilterBar, { activeFilterCount } from '../components/FilterBar.jsx';
import DashboardInsightModal from '../components/DashboardInsightModal.jsx';
import AiMark from '../components/AiMark.jsx';
import EditableGrid from '../components/EditableGrid.jsx';
import { api } from '../lib/api.js';
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
  const { isAdmin, insightsEnabled } = useAuth();
  const { previewEntityId } = useOutletContext() || {};
  const { theme: appTheme } = useTheme();
  const [def, setDef] = useState(null);
  const [setInfo, setSetInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filterValues, setFilterValues] = useState({});
  const [locked, setLocked] = useState({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const suiteP = suiteId ? api.mySuite(suiteId).catch(() => null) : Promise.resolve(null);
    Promise.all([api.getDashboard(id), suiteP])
      .then(([data, suite]) => {
        setDef(data);
        setSetInfo(suite);
        // Lock filters from the suite's locks. A lock keyed by the filter NAME
        // (e.g. "Past Event") wins over one keyed by the field, so the
        // Current/Past/Comparison event filters lock independently. Matching is
        // case/whitespace-insensitive — dashboards name the same filter
        // inconsistently ("Organiser Name" vs "organiser name").
        const lockMap = suite?.lockedFilters || {};
        const norm = {};
        for (const [k, v] of Object.entries(lockMap)) norm[k.trim().toLowerCase()] = v;
        const defaults = {};
        const lockedMap = {};
        for (const f of data.filters || []) {
          defaults[f.name] = f.default_value || '';
          const field = (f.field || f.dimension || '').trim().toLowerCase();
          const nameKey = (f.name || '').trim().toLowerCase();
          const v = norm[nameKey] != null ? norm[nameKey] : (field ? norm[field] : undefined);
          if (v != null && v !== '') {
            defaults[f.name] = v;
            lockedMap[f.name] = true;
          }
        }
        // Shared-link filters (?f=) override the defaults — but never a lock.
        try {
          const f = new URLSearchParams(window.location.search).get('f');
          if (f) {
            const shared = JSON.parse(decodeURIComponent(f));
            for (const [k, v] of Object.entries(shared || {})) {
              if (k in defaults && !lockedMap[k] && typeof v === 'string') defaults[k] = v;
            }
          }
        } catch { /* malformed share param — ignore */ }
        setFilterValues(defaults);
        setLocked(lockedMap);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id, suiteId]);

  const handleFilterChange = useCallback((name, value) => {
    setFilterValues((prev) => ({ ...prev, [name]: value }));
  }, []);

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
    <ScopeProvider suiteId={suiteId || null} dashboardContext={def.aiContext || ''}>
    <PinProvider dashboardId={id} entityId={previewEntityId || null} isAdmin={isAdmin} enabled={pinsEnabled}>
      <div style={shellStyle}>
        {/* On mobile inside a suite the sticky "☰ Menu" bar already shows the
            context, so skip this header to avoid stacking two titles. */}
        {!(isMobile && suiteId) && (
          <div style={{ background: 'var(--frost)', backdropFilter: 'saturate(180%) blur(20px)', WebkitBackdropFilter: 'saturate(180%) blur(20px)', borderBottom: '1px solid var(--hairline)', padding: isMobile ? '12px 14px' : '16px 22px', display: 'flex', alignItems: 'center', gap: isMobile ? 10 : 16 }}>
            <Link to={backTo} title="Home" aria-label="Home" className="btn-key" style={homeBtn}><HomeIcon /></Link>
            <div style={{ flex: 1, minWidth: 0 }}>
              {setInfo && <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>{setInfo.name}</div>}
              <h2 style={{ fontSize: isMobile ? 17 : 21, fontWeight: 600, letterSpacing: '-0.02em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{headerTitle}</h2>
            </div>
            {!isMobile && <ShareButton suiteId={suiteId} dashboardId={id} filterValues={filterValues} />}
            {!isMobile && (
              <button className="no-print" style={summaryBtn} onClick={() => window.print()} title="Download / print this dashboard as PDF">⤓ PDF</button>
            )}
            {canSummarize && !isMobile && (
              <button className="btn-key no-print" style={summaryBtn} onClick={() => setSummaryOpen(true)} title="AI summary of the whole dashboard"><AiMark size={20} /> Summary</button>
            )}
            {hasFilters && !isMobile && (
              <button style={filtersBtn(filtersOpen)} onClick={() => setFiltersOpen(v => !v)}>
                <span>⚲ Filters</span>
                {activeCount > 0 && <span key={activeCount} className="pop" style={countBadge}>{activeCount}</span>}
                <span style={{ fontSize: 11, opacity: 0.7 }}>{filtersOpen ? '▴' : '▾'}</span>
              </button>
            )}
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

        {/* On mobile inside a suite the header is hidden, so the Summary button
            shares the filters bar (or gets its own compact row if no filters). */}
        {canSummarize && isMobile && suiteId && !hasFilters && (
          <div style={{ background: 'var(--card)', borderBottom: '1px solid var(--hairline)', padding: '8px 14px', display: 'flex', justifyContent: 'flex-start' }}>
            <button className="btn-key" style={summaryBtn} onClick={() => setSummaryOpen(true)}><AiMark size={18} /> Summary</button>
          </div>
        )}

        {hasFilters && (
          <FilterBar
            filters={def.filters} values={filterValues} onChange={handleFilterChange} locked={locked}
            open={filtersOpen} onClose={() => setFiltersOpen(false)}
            leading={canSummarize && isMobile && suiteId ? (
              <button className="btn-key" style={summaryBtn} onClick={() => setSummaryOpen(true)}><AiMark size={18} /> Summary</button>
            ) : null}
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
const filtersBtn = (active) => ({ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 16px', background: active ? 'rgba(128,128,128,0.2)' : 'rgba(128,128,128,0.15)', color: 'var(--text)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' });
const countBadge = { background: 'var(--brand)', color: '#fff', fontSize: 11, fontWeight: 700, borderRadius: 980, minWidth: 18, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px' };
const summaryBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'rgba(128,128,128,0.15)', color: 'var(--text)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const homeBtn = { flexShrink: 0, width: 34, height: 34, borderRadius: '50%', background: 'rgba(128,128,128,0.15)', color: 'var(--text)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' };

function HomeIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h5.5v-6h3v6H19V9.5" />
    </svg>
  );
}

// Mint a short link carrying the current filters, copy it, flash ✓. The
// recipient still logs in; scoping applies to THEM (a link is never a bypass).
function ShareButton({ suiteId, dashboardId, filterValues }) {
  const [state, setState] = useState('idle'); // idle | busy | copied | err
  async function share() {
    setState('busy');
    try {
      const { path } = await api.createShareLink({ suiteId, dashboardId, filters: filterValues });
      const url = `${window.location.origin}${path}`;
      try { await navigator.clipboard.writeText(url); } catch { window.prompt('Copy this link:', url); }
      setState('copied');
      setTimeout(() => setState('idle'), 2200);
    } catch {
      setState('err');
      setTimeout(() => setState('idle'), 2200);
    }
  }
  return (
    <button className="no-print" style={summaryBtn} onClick={share} disabled={state === 'busy'} title="Copy a link to this dashboard with your current filters">
      {state === 'copied' ? '✓ Link copied' : state === 'err' ? '⚠ Try again' : state === 'busy' ? '…' : '↗ Share'}
    </button>
  );
}

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

function Centered({ children, error }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
      <p style={{ fontSize: 15, color: error ? 'var(--error)' : 'var(--muted)' }}>{children}</p>
    </div>
  );
}
