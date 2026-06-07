import { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import FilterBar from '../components/FilterBar.jsx';
import EditableGrid from '../components/EditableGrid.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { ScopeProvider } from '../lib/ScopeContext.jsx';

// Read-only render of a saved dashboard. When opened inside a Suite
// (/suite/:suiteId/d/:id) the suite's locked filters are pre-filled + locked and
// every query is scoped to that suite. Admins opening /d/:id directly are unscoped.
export default function ViewPage() {
  const isMobile = useIsMobile();
  const { id, suiteId } = useParams();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [def, setDef] = useState(null);
  const [setInfo, setSetInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filterValues, setFilterValues] = useState({});
  const [locked, setLocked] = useState({});

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
  const backTo = '/';

  return (
    <ScopeProvider suiteId={suiteId || null}>
      <div
        style={{
          display: 'flex', flexDirection: 'column', flex: 1,
          background: theme.background || 'var(--bg)',
          '--tile-bg': theme.tileBackground || '#fff',
        }}
      >
        {/* On mobile inside a suite the sticky "☰ Menu" bar already shows the
            context, so skip this header to avoid stacking two titles. */}
        {!(isMobile && suiteId) && (
          <div style={{ background: 'rgba(255,255,255,0.72)', backdropFilter: 'saturate(180%) blur(20px)', WebkitBackdropFilter: 'saturate(180%) blur(20px)', borderBottom: '1px solid var(--hairline)', padding: isMobile ? '12px 14px' : '16px 22px', display: 'flex', alignItems: 'center', gap: isMobile ? 10 : 16 }}>
            <Link to={backTo} style={{ color: 'var(--muted)', fontSize: 13, textDecoration: 'none' }}>← Back</Link>
            <div style={{ flex: 1, minWidth: 0 }}>
              {setInfo && <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>{setInfo.name}</div>}
              <h2 style={{ fontSize: isMobile ? 17 : 21, fontWeight: 600, letterSpacing: '-0.02em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{def.title}</h2>
            </div>
            {isAdmin && !isMobile && <button style={editBtn} onClick={() => navigate(`/d/${id}/edit`)}>Edit</button>}
          </div>
        )}

        {def.filters?.length > 0 && (
          <FilterBar filters={def.filters} values={filterValues} onChange={handleFilterChange} locked={locked} />
        )}

        <div style={{ flex: 1, padding: isMobile ? '12px' : '22px', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
          {def.tiles?.length || def.carousels?.length ? (
            <EditableGrid tiles={def.tiles || []} carousels={def.carousels || []} filterValues={filterValues} editable={false} />
          ) : (
            <Centered>This dashboard has no tiles yet.</Centered>
          )}
        </div>
      </div>
    </ScopeProvider>
  );
}

const editBtn = { padding: '8px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer', boxShadow: '0 1px 2px rgba(0,0,0,0.08)' };

function Centered({ children, error }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
      <p style={{ fontSize: 15, color: error ? 'var(--error)' : 'var(--muted)' }}>{children}</p>
    </div>
  );
}
