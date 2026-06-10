import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { vtNavigate } from '../lib/viewTransition.js';
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
        // Current/Past/Comparison event filters lock independently.
        const lockMap = suite?.lockedFilters || {};
        const defaults = {};
        const lockedMap = {};
        for (const f of data.filters || []) {
          defaults[f.name] = f.default_value || '';
          const field = f.field || f.dimension;
          const v = lockMap[f.name] != null ? lockMap[f.name] : (field ? lockMap[field] : undefined);
          if (v != null && v !== '') {
            defaults[f.name] = v;
            lockedMap[f.name] = true;
          }
        }
        setFilterValues(defaults);
        setLocked(lockedMap);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id, suiteId]);

  const handleFilterChange = useCallback((name, value) => {
    setFilterValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  if (loading) return <Centered>Loading dashboard…</Centered>;
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

  // Sub-dashboard tabs: if this dashboard is a parent with children — or one of
  // the children — surface the whole family as a tab bar (parent first).
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

  return (
    <ScopeProvider suiteId={suiteId || null} dashboardContext={def.aiContext || ''}>
      <div style={shellStyle}>
        {/* On mobile inside a suite the sticky "☰ Menu" bar already shows the
            context, so skip this header to avoid stacking two titles. */}
        {!(isMobile && suiteId) && (
          <div style={{ background: 'var(--frost)', backdropFilter: 'saturate(180%) blur(20px)', WebkitBackdropFilter: 'saturate(180%) blur(20px)', borderBottom: '1px solid var(--hairline)', padding: isMobile ? '12px 14px' : '16px 22px', display: 'flex', alignItems: 'center', gap: isMobile ? 10 : 16 }}>
            <Link to={backTo} style={{ color: 'var(--muted)', fontSize: 13, textDecoration: 'none' }}>← Back</Link>
            <div style={{ flex: 1, minWidth: 0 }}>
              {setInfo && <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>{setInfo.name}</div>}
              <h2 style={{ fontSize: isMobile ? 17 : 21, fontWeight: 600, letterSpacing: '-0.02em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{def.title}</h2>
            </div>
            {canSummarize && !isMobile && (
              <button className="btn-key" style={summaryBtn} onClick={() => setSummaryOpen(true)} title="AI summary of the whole dashboard"><AiMark size={20} /> Summary</button>
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

        {/* Sub-dashboard tab bar (parent + its tabs). */}
        {family && (
          <SubTabs
            tabs={family}
            activeId={id}
            isMobile={isMobile}
            onSelect={(tid) => vtNavigate(navigate, `/suite/${suiteId}/d/${tid}`)}
          />
        )}

        {/* On mobile inside a suite the header is hidden, so offer the summary here. */}
        {canSummarize && isMobile && suiteId && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 12px 0' }}>
            <button className="btn-key" style={summaryBtn} onClick={() => setSummaryOpen(true)}><AiMark size={20} /> Summary</button>
          </div>
        )}

        {hasFilters && (
          <FilterBar filters={def.filters} values={filterValues} onChange={handleFilterChange} locked={locked} open={filtersOpen} onClose={() => setFiltersOpen(false)} />
        )}

        <div style={{ flex: 1, padding: isMobile ? '12px' : '22px', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
          {def.tiles?.length || def.carousels?.length ? (
            <EditableGrid tiles={def.tiles || []} carousels={def.carousels || []} filterValues={filterValues} editable={false} />
          ) : (
            <Centered>This dashboard has no tiles yet.</Centered>
          )}
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
    </ScopeProvider>
  );
}

const editBtn = { padding: '8px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer', boxShadow: '0 1px 2px rgba(128,128,128,0.2)' };
const filtersBtn = (active) => ({ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 16px', background: active ? 'rgba(128,128,128,0.2)' : 'rgba(128,128,128,0.15)', color: 'var(--text)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' });
const countBadge = { background: 'var(--brand)', color: '#fff', fontSize: 11, fontWeight: 700, borderRadius: 980, minWidth: 18, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px' };
const summaryBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'rgba(128,128,128,0.15)', color: 'var(--text)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };

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
