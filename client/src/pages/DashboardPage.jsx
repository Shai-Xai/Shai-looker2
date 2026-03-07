import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import FilterBar from '../components/FilterBar.jsx';
import DashboardGrid from '../components/DashboardGrid.jsx';

export default function DashboardPage() {
  const { dashboardId } = useParams();
  const [definition, setDefinition] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // filterValues: { filterName -> value string }
  const [filterValues, setFilterValues] = useState({});

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/dashboard/${encodeURIComponent(dashboardId)}/view`)
      .then(r => r.json())
      .then(data => {
        if (data.error) throw new Error(data.error);
        setDefinition(data);
        // Seed filter values from defaults
        const defaults = {};
        for (const f of data.filters || []) {
          defaults[f.name] = f.default_value || '';
        }
        setFilterValues(defaults);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [dashboardId]);

  const handleFilterChange = useCallback((name, value) => {
    setFilterValues(prev => ({ ...prev, [name]: value }));
  }, []);

  if (loading) return <CenteredMessage>Loading dashboard…</CenteredMessage>;
  if (error) return <CenteredMessage error>Error: {error}</CenteredMessage>;
  if (!definition) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
      {/* Dashboard header */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e0e0e0', padding: '14px 24px', display: 'flex', alignItems: 'center', gap: 16 }}>
        <Link to="/" style={{ color: 'var(--muted)', fontSize: 13, textDecoration: 'none' }}>← Back</Link>
        <h2 style={{ fontSize: 18, fontWeight: 700, flex: 1 }}>{definition.title}</h2>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Dashboard {definition.id}</span>
      </div>

      {/* Filters */}
      {definition.filters.length > 0 && (
        <FilterBar
          filters={definition.filters}
          values={filterValues}
          onChange={handleFilterChange}
        />
      )}

      {/* Tile grid */}
      <div style={{ flex: 1, padding: '16px 24px', overflowY: 'auto' }}>
        <DashboardGrid
          tiles={definition.tiles}
          filterValues={filterValues}
        />
      </div>
    </div>
  );
}

function CenteredMessage({ children, error }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
      <p style={{ fontSize: 16, color: error ? 'var(--error)' : 'var(--muted)' }}>{children}</p>
    </div>
  );
}
