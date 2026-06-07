import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';

// Landing panel inside the client shell — a friendly welcome + suite cards
// that jump straight to a suite's first dashboard. The sidebar handles the rest.
export default function ClientHome() {
  const navigate = useNavigate();
  const [suites, setSuites] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { api.mySuites().then(setSuites).catch(() => {}).finally(() => setLoading(false)); }, []);

  async function openSuite(su) {
    try {
      const d = await api.mySuite(su.id);
      const first = d.sets.flatMap((s) => s.dashboards)[0];
      if (first) navigate(`/suite/${su.id}/d/${first.id}`);
    } catch (_) { /* ignore */ }
  }

  return (
    <main style={{ flex: 1, padding: '40px 28px', maxWidth: 900, margin: '0 auto', width: '100%' }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 6 }}>Welcome</h1>
      <p style={{ color: 'var(--muted)', marginBottom: 26 }}>Choose a dashboard from the menu on the left, or open a suite below.</p>
      {loading ? (
        <p style={{ color: 'var(--muted)' }}>Loading…</p>
      ) : suites.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>No suites have been assigned to your account yet.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
          {suites.map((su) => (
            <button key={su.id} style={card} onClick={() => openSuite(su)}>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{su.name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{su.entityName} · {su.dashboardCount} dashboard{su.dashboardCount === 1 ? '' : 's'}</div>
              <div style={{ marginTop: 14, fontSize: 13, fontWeight: 600, color: 'var(--brand)' }}>Open →</div>
            </button>
          ))}
        </div>
      )}
    </main>
  );
}

const card = { textAlign: 'left', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md, 14px)', padding: 20, cursor: 'pointer', boxShadow: 'var(--shadow-sm)' };
