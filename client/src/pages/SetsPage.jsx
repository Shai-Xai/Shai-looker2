import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';

// Client landing: the Dashboard Sets the user can open, grouped by Entity.
// (Admins use the flat dashboard list / builder instead.)
export default function SetsPage() {
  const navigate = useNavigate();
  const [sets, setSets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.mySets().then(setSets).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  // Group by entity so a user who belongs to several entities sees them split.
  const groups = [];
  for (const s of sets) {
    let g = groups.find((x) => x.entityId === s.entityId);
    if (!g) { g = { entityId: s.entityId, entityName: s.entityName, sets: [] }; groups.push(g); }
    g.sets.push(s);
  }

  return (
    <main style={{ flex: 1, padding: '32px 22px', maxWidth: 1000, margin: '0 auto', width: '100%' }}>
      {loading ? (
        <p style={{ color: 'var(--muted)' }}>Loading…</p>
      ) : error ? (
        <p style={{ color: 'var(--error)' }}>{error}</p>
      ) : sets.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>No dashboard sets have been assigned to your account yet.</p>
      ) : (
        groups.map((g) => (
          <section key={g.entityId} style={{ marginBottom: 30 }}>
            {groups.length > 1 && (
              <h2 style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: 14 }}>{g.entityName}</h2>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
              {g.sets.map((s) => (
                <button key={s.id} style={card} onClick={() => navigate(`/s/${s.id}`)}>
                  <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>{s.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{s.dashboardCount} dashboard{s.dashboardCount === 1 ? '' : 's'}</div>
                  <div style={{ marginTop: 14, fontSize: 13, fontWeight: 600, color: 'var(--brand)' }}>Open →</div>
                </button>
              ))}
            </div>
          </section>
        ))
      )}
    </main>
  );
}

const card = { textAlign: 'left', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md, 14px)', padding: 20, cursor: 'pointer', boxShadow: 'var(--shadow-sm)' };
