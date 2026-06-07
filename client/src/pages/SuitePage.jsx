import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api.js';

// One Suite: its Sets (Ticketing, Cashless, …), each with its dashboards.
// Opening a dashboard carries the suite context (scoped + filter-locked).
export default function SuitePage() {
  const { suiteId } = useParams();
  const navigate = useNavigate();
  const [suite, setSuite] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    api.mySuite(suiteId).then(setSuite).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [suiteId]);

  if (loading) return <Centered>Loading…</Centered>;
  if (error) return <Centered error>{error}</Centered>;
  if (!suite) return null;

  return (
    <main style={{ flex: 1, padding: '28px 22px', maxWidth: 1060, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 22 }}>
        <Link to="/" style={{ color: 'var(--muted)', fontSize: 13, textDecoration: 'none' }}>← All suites</Link>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }}>{suite.entityName}</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>{suite.name}</h1>
        </div>
      </div>

      {suite.sets.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>This suite has no sets yet.</p>
      ) : (
        suite.sets.map((set) => (
          <section key={set.id} style={{ marginBottom: 30 }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>{set.name}</h2>
            {set.dashboards.length === 0 ? (
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>No dashboards in this set.</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
                {set.dashboards.map((d) => (
                  <button key={d.id} style={card} onClick={() => navigate(`/suite/${suiteId}/d/${d.id}`)}>
                    <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.3 }}>{d.title}</div>
                    {d.description && <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{d.description}</div>}
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>{d.tileCount} tiles</div>
                    <div style={{ marginTop: 12, fontSize: 13, fontWeight: 600, color: 'var(--brand)' }}>View →</div>
                  </button>
                ))}
              </div>
            )}
          </section>
        ))
      )}
    </main>
  );
}

const card = { textAlign: 'left', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md, 14px)', padding: 18, cursor: 'pointer', boxShadow: 'var(--shadow-sm)' };

function Centered({ children, error }) {
  return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48 }}><p style={{ fontSize: 15, color: error ? 'var(--error)' : 'var(--muted)' }}>{children}</p></div>;
}
