import { useState, useEffect } from 'react';
import { Outlet, useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// Persistent client shell: a left sidebar tree of Suites → Sets → Dashboards,
// with the selected dashboard rendered in the main area.
export default function ClientLayout() {
  const { suiteId, id } = useParams();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [suites, setSuites] = useState([]);
  const [details, setDetails] = useState({}); // suiteId -> { sets:[{id,name,dashboards}] }
  const [openSuites, setOpenSuites] = useState({});
  const [openSets, setOpenSets] = useState({});
  const [loading, setLoading] = useState(true);
  const [navOpen, setNavOpen] = useState(false); // mobile drawer

  useEffect(() => { api.mySuites().then(setSuites).catch(() => {}).finally(() => setLoading(false)); }, []);

  async function ensureDetail(sid) {
    if (details[sid]) return;
    const d = await api.mySuite(sid).catch(() => null);
    if (d) setDetails((prev) => ({ ...prev, [sid]: d }));
  }
  function toggleSuite(sid) {
    setOpenSuites((p) => ({ ...p, [sid]: !p[sid] }));
    ensureDetail(sid);
  }

  // Auto-expand the suite (and its sets) for the active dashboard.
  useEffect(() => {
    if (!suiteId) return;
    setOpenSuites((p) => ({ ...p, [suiteId]: true }));
    ensureDetail(suiteId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suiteId]);
  useEffect(() => {
    const d = details[suiteId];
    if (!d || !id) return;
    for (const set of d.sets) if (set.dashboards.some((x) => x.id === id)) setOpenSets((p) => ({ ...p, [set.id]: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [details, suiteId, id]);

  const go = (sid, did) => { navigate(`/suite/${sid}/d/${did}`); if (isMobile) setNavOpen(false); };

  const sidebar = (
    <nav style={{ ...sidebarStyle, ...(isMobile ? mobileSidebar : null) }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', padding: '4px 12px 10px' }}>Suites</div>
      {loading ? (
        <div style={{ padding: 12, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
      ) : suites.length === 0 ? (
        <div style={{ padding: 12, color: 'var(--muted)', fontSize: 13 }}>No suites assigned.</div>
      ) : (
        suites.map((su) => (
          <div key={su.id}>
            <button style={{ ...rowBtn, fontWeight: 700 }} onClick={() => toggleSuite(su.id)}>
              <Caret open={!!openSuites[su.id]} />
              <span style={ellip}>{su.name}</span>
            </button>
            {openSuites[su.id] && (
              <div>
                {!details[su.id] ? (
                  <div style={{ ...subRow, color: 'var(--muted)' }}>Loading…</div>
                ) : details[su.id].sets.length === 0 ? (
                  <div style={{ ...subRow, color: 'var(--muted)' }}>No sets</div>
                ) : (
                  details[su.id].sets.map((set) => (
                    <div key={set.id}>
                      <button style={{ ...rowBtn, paddingLeft: 26, fontWeight: 600, fontSize: 13 }} onClick={() => setOpenSets((p) => ({ ...p, [set.id]: !p[set.id] }))}>
                        <Caret open={!!openSets[set.id]} />
                        <span style={ellip}>{set.name}</span>
                      </button>
                      {openSets[set.id] && set.dashboards.map((d) => {
                        const active = d.id === id && su.id === suiteId;
                        return (
                          <button key={d.id} onClick={() => go(su.id, d.id)} style={{ ...rowBtn, paddingLeft: 46, fontSize: 13, color: active ? 'var(--brand)' : 'var(--text)', background: active ? '#fff0f3' : 'transparent', fontWeight: active ? 600 : 400 }}>
                            <span style={ellip}>{d.title}</span>
                          </button>
                        );
                      })}
                      {openSets[set.id] && set.dashboards.length === 0 && <div style={{ ...subRow, paddingLeft: 46, color: 'var(--muted)' }}>No dashboards</div>}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        ))
      )}
    </nav>
  );

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative' }}>
      {/* Desktop: sidebar always shown. Mobile: a drawer toggled by a button. */}
      {!isMobile && sidebar}
      {isMobile && navOpen && (
        <div style={{ position: 'fixed', inset: 0, top: 56, zIndex: 50, display: 'flex' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)' }} onClick={() => setNavOpen(false)} />
          {sidebar}
        </div>
      )}
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
        {isMobile && (
          <button style={menuBtn} onClick={() => setNavOpen(true)}>☰ Menu</button>
        )}
        <Outlet />
      </main>
    </div>
  );
}

function Caret({ open }) {
  return <span style={{ display: 'inline-block', width: 14, fontSize: 10, color: '#999', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>▶</span>;
}

const sidebarStyle = { width: 260, flexShrink: 0, borderRight: '1px solid var(--hairline)', background: 'var(--card)', overflowY: 'auto', padding: '14px 6px' };
const mobileSidebar = { position: 'relative', zIndex: 51, height: '100%', boxShadow: '4px 0 24px rgba(0,0,0,0.15)' };
const rowBtn = { display: 'flex', alignItems: 'center', gap: 4, width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', padding: '7px 12px', borderRadius: 8, fontSize: 14, color: 'var(--text)', lineHeight: 1.3 };
const subRow = { padding: '6px 12px', fontSize: 13 };
const ellip = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const menuBtn = { alignSelf: 'flex-start', margin: '12px 0 0 14px', padding: '7px 14px', borderRadius: 980, border: '1px solid var(--hairline)', background: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
