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
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('howler_nav_collapsed') === '1'); // desktop
  const toggleCollapsed = () => setCollapsed((c) => { localStorage.setItem('howler_nav_collapsed', c ? '0' : '1'); return !c; });

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
    <nav className="howler-sidebar" style={{ ...sidebarStyle, ...(isMobile ? mobileSidebar : null) }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '6px 8px 12px 14px' }}>
        <span style={{ flex: 1, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>Suites</span>
        {!isMobile && <button onClick={toggleCollapsed} title="Collapse sidebar" style={iconBtn}>⟨</button>}
      </div>
      {loading ? (
        <div style={{ padding: 14, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
      ) : suites.length === 0 ? (
        <div style={{ padding: 14, color: 'var(--muted)', fontSize: 13 }}>No suites assigned.</div>
      ) : (
        suites.map((su) => (
          <div key={su.id} style={{ marginBottom: 2 }}>
            <button className="nav-row" style={{ ...rowBtn, fontWeight: 600 }} onClick={() => toggleSuite(su.id)}>
              <Caret open={!!openSuites[su.id]} />
              <Ico v={su.icon} size={17} />
              <span style={ellip}>{su.name}</span>
            </button>
            {openSuites[su.id] && (
              <div style={{ marginTop: 1 }}>
                {!details[su.id] ? (
                  <div style={{ ...subRow, color: 'var(--muted)' }}>Loading…</div>
                ) : details[su.id].sets.length === 0 ? (
                  <div style={{ ...subRow, color: 'var(--muted)' }}>No sets</div>
                ) : (
                  details[su.id].sets.map((set) => (
                    <div key={set.id}>
                      <button className="nav-row" style={{ ...rowBtn, paddingLeft: 28, fontWeight: 500, fontSize: 13, color: 'var(--muted-2)' }} onClick={() => setOpenSets((p) => ({ ...p, [set.id]: !p[set.id] }))}>
                        <Caret open={!!openSets[set.id]} small />
                        <Ico v={set.icon} size={15} />
                        <span style={ellip}>{set.name}</span>
                      </button>
                      {openSets[set.id] && set.dashboards.map((d) => {
                        const active = d.id === id && su.id === suiteId;
                        return (
                          <button key={d.id} onClick={() => go(su.id, d.id)} className={`nav-row${active ? ' active' : ''}`} style={{ ...rowBtn, paddingLeft: 52, fontSize: 13, fontWeight: active ? 600 : 450 }}>
                            <span style={{ ...dot, background: active ? 'var(--brand)' : 'rgba(0,0,0,0.18)' }} />
                            <span style={ellip}>{d.title}</span>
                          </button>
                        );
                      })}
                      {openSets[set.id] && set.dashboards.length === 0 && <div style={{ ...subRow, paddingLeft: 52, color: 'var(--muted)' }}>No dashboards</div>}
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
      {/* Desktop: sidebar shown unless collapsed. Mobile: a drawer. */}
      {!isMobile && !collapsed && sidebar}
      {isMobile && navOpen && (
        <div style={{ position: 'fixed', inset: 0, top: 56, zIndex: 50, display: 'flex' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)' }} onClick={() => setNavOpen(false)} />
          {sidebar}
        </div>
      )}
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
        {(isMobile || collapsed) && (
          <button style={menuBtn} onClick={() => (isMobile ? setNavOpen(true) : toggleCollapsed())}>☰ Suites</button>
        )}
        <Outlet />
      </main>
    </div>
  );
}

function Ico({ v, size = 16 }) {
  if (!v) return null;
  return v.startsWith('data:')
    ? <img src={v} alt="" style={{ width: size, height: size, objectFit: 'contain', borderRadius: 3, flexShrink: 0 }} />
    : <span style={{ fontSize: size - 1, lineHeight: 1, flexShrink: 0 }}>{v}</span>;
}
function Caret({ open, small }) {
  return <span className="nav-caret" style={{ display: 'inline-block', width: 12, fontSize: small ? 8 : 9, color: '#b0b0b6', transform: open ? 'rotate(90deg)' : 'none' }}>▶</span>;
}

const sidebarStyle = { width: 264, flexShrink: 0, overflowY: 'auto', padding: '16px 10px' };
const mobileSidebar = { position: 'relative', zIndex: 51, height: '100%', boxShadow: '4px 0 24px rgba(0,0,0,0.15)' };
const rowBtn = { display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', padding: '8px 12px', borderRadius: 9, fontSize: 14, color: 'var(--text)', lineHeight: 1.3 };
const subRow = { padding: '7px 12px', fontSize: 13 };
const ellip = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const dot = { flexShrink: 0, width: 5, height: 5, borderRadius: '50%', display: 'inline-block' };
const menuBtn = { alignSelf: 'flex-start', margin: '12px 0 0 14px', padding: '7px 14px', borderRadius: 980, border: '1px solid var(--hairline)', background: 'rgba(255,255,255,0.8)', backdropFilter: 'blur(8px)', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const iconBtn = { width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--hairline)', borderRadius: 7, background: '#fff', color: 'var(--muted-2)', fontSize: 12, cursor: 'pointer' };
