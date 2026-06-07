import { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import FilterBar from '../components/FilterBar.jsx';
import EditableGrid from '../components/EditableGrid.jsx';
import Carousel from '../components/Carousel.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

// Read-only render of a saved dashboard.
export default function ViewPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [def, setDef] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filterValues, setFilterValues] = useState({});
  const [locked, setLocked] = useState({});

  useEffect(() => {
    setLoading(true);
    setError(null);
    // Clients: fetch their tenant so we can pre-fill + lock the organiser/event
    // filters to their scope. Admins see normal, editable filters.
    const tenantP = isAdmin ? Promise.resolve(null) : api.listTenants().then((ts) => ts[0] || null).catch(() => null);
    Promise.all([api.getDashboard(id), tenantP])
      .then(([data, tenant]) => {
        setDef(data);
        const sf = tenant?.scopeFields || {};
        const orgVals = (tenant?.organiserNames || []);
        const evVals = (tenant?.eventNames || []);
        const defaults = {};
        const lockedMap = {};
        for (const f of data.filters || []) {
          defaults[f.name] = f.default_value || '';
          const field = f.field || f.dimension;
          if (tenant && field && field === sf.organiser && orgVals.length) {
            defaults[f.name] = orgVals.join(',');
            lockedMap[f.name] = true;
          } else if (tenant && field && field === sf.event && evVals.length) {
            defaults[f.name] = evVals.join(',');
            lockedMap[f.name] = true;
          }
        }
        setFilterValues(defaults);
        setLocked(lockedMap);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id, isAdmin]);

  const handleFilterChange = useCallback((name, value) => {
    setFilterValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  if (loading) return <Centered>Loading dashboard…</Centered>;
  if (error) return <Centered error>Error: {error}</Centered>;
  if (!def) return null;

  const theme = def.theme || {};

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        background: theme.background || '#f5f6f8',
        '--tile-bg': theme.tileBackground || '#fff',
      }}
    >
      <div style={{ background: '#fff', borderBottom: '1px solid #e0e0e0', padding: '14px 24px', display: 'flex', alignItems: 'center', gap: 16 }}>
        <Link to="/" style={{ color: 'var(--muted)', fontSize: 13, textDecoration: 'none' }}>← Back</Link>
        <h2 style={{ fontSize: 18, fontWeight: 700, flex: 1 }}>{def.title}</h2>
        {isAdmin && <button style={editBtn} onClick={() => navigate(`/d/${id}/edit`)}>Edit</button>}
      </div>

      {def.filters?.length > 0 && (
        <FilterBar filters={def.filters} values={filterValues} onChange={handleFilterChange} locked={locked} />
      )}

      <div style={{ flex: 1, padding: '16px 24px', overflowY: 'auto' }}>
        {(def.carousels || []).slice(0, def.gridAfter || 0).map((c) => (
          <Carousel key={c.id} carousel={c} filterValues={filterValues} editable={false} />
        ))}

        {def.tiles?.length ? (
          <EditableGrid tiles={def.tiles} filterValues={filterValues} editable={false} />
        ) : (!def.carousels?.length && (
          <Centered>This dashboard has no tiles yet. <Link to={`/d/${id}/edit`} style={{ marginLeft: 6 }}>Add some →</Link></Centered>
        ))}

        {(def.carousels || []).slice(def.gridAfter || 0).map((c) => (
          <Carousel key={c.id} carousel={c} filterValues={filterValues} editable={false} />
        ))}
      </div>
    </div>
  );
}

const editBtn = { padding: '7px 16px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' };

function Centered({ children, error }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
      <p style={{ fontSize: 15, color: error ? 'var(--error)' : 'var(--muted)' }}>{children}</p>
    </div>
  );
}
