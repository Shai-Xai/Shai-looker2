import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { Outlet, useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useAuth } from '../lib/auth.jsx';
import { vtNavigate } from '../lib/viewTransition.js';

// Persistent client shell: a left sidebar tree of Suites → Sets → Dashboards,
// with the selected dashboard rendered in the main area.
export default function ClientLayout() {
  const { suiteId, id } = useParams();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { isAdmin } = useAuth();
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

  const go = (sid, did) => {
    if (!(sid === suiteId && did === id)) vtNavigate(navigate, `/suite/${sid}/d/${did}`);
    if (isMobile) setNavOpen(false);
  };

  // Sliding active indicator: track the active dashboard button and glide a
  // single pill to its position whenever the selection/layout changes.
  const navRef = useRef(null);
  const activeRef = useRef(null);
  const [indicator, setIndicator] = useState({ y: 0, h: 0, show: false });
  const measure = () => {
    const btn = activeRef.current; const nav = navRef.current;
    if (!btn || !nav) { setIndicator((i) => ({ ...i, show: false })); return; }
    setIndicator({ y: btn.offsetTop, h: btn.offsetHeight, show: true });
  };
  useLayoutEffect(() => {
    measure();
    // Re-measure after the expand/collapse animation settles (positions shift).
    const t = setTimeout(measure, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, suiteId, openSuites, openSets, details, collapsed, loading, isMobile, navOpen]);

  // Title of the active dashboard (for the mobile menu bar).
  let activeTitle = '';
  const cur = details[suiteId];
  if (cur && id) for (const set of cur.sets) { const dash = set.dashboards.find((x) => x.id === id); if (dash) { activeTitle = dash.title; break; } }

  // When an admin previews, scope the sidebar to just the active suite's client
  // (entity) so the preview faithfully shows that one account, not every suite.
  const activeEntityId = isAdmin && suiteId ? suites.find((s) => s.id === suiteId)?.entityId : null;
  const visibleSuites = activeEntityId ? suites.filter((s) => s.entityId === activeEntityId) : suites;

  // When the visible suites all belong to one client, show that client's brand
  // (logo / name) at the top of the sidebar.
  const uniqueEntityIds = [...new Set(visibleSuites.map((s) => s.entityId))];
  const brand = uniqueEntityIds.length === 1 ? visibleSuites.find((s) => s.entityId === uniqueEntityIds[0]) : null;

  const sidebar = (
    <nav ref={navRef} className="howler-sidebar" style={{ ...sidebarStyle, position: 'relative', ...(isMobile ? mobileSidebar : null) }}>
      <div className="nav-indicator" style={{ transform: `translateY(${indicator.y}px)`, height: indicator.h, opacity: indicator.show ? 1 : 0 }} />
      {brand && (brand.entityLogo || brand.entityName) && (
        <div style={brandHeader}>
          {brand.entityLogo && <img src={brand.entityLogo} alt="" style={{ height: 34, maxWidth: 90, objectFit: 'contain', flexShrink: 0 }} />}
          {brand.entityName && <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{brand.entityName}</span>}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', padding: '6px 8px 12px 14px' }}>
        <span style={{ flex: 1, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>Suites</span>
        {!isMobile && <button onClick={toggleCollapsed} title="Collapse sidebar" style={iconBtn}>⟨</button>}
      </div>
      {loading ? (
        <div style={{ padding: 14, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
      ) : visibleSuites.length === 0 ? (
        <div style={{ padding: 14, color: 'var(--muted)', fontSize: 13 }}>No suites assigned.</div>
      ) : (
        visibleSuites.map((su) => (
          <div key={su.id} style={{ marginBottom: 2 }}>
            <button className="nav-row" style={{ ...rowBtn, fontWeight: 600 }} onClick={() => toggleSuite(su.id)}>
              <Caret open={!!openSuites[su.id]} />
              <Ico v={su.icon} size={22} />
              <span style={ellip}>{su.name}</span>
            </button>
            <div className={`collapsey${openSuites[su.id] ? ' open' : ''}`}>
              <div className="collapsey-inner" style={{ marginTop: 1 }}>
                {!details[su.id] ? (
                  openSuites[su.id] && <div style={{ ...subRow, color: 'var(--muted)' }}>Loading…</div>
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
                      <div className={`collapsey${openSets[set.id] ? ' open' : ''}`}>
                        <div className="collapsey-inner">
                          {set.dashboards.map((d) => {
                            const active = d.id === id && su.id === suiteId;
                            return (
                              <button key={d.id} ref={active ? activeRef : null} onClick={() => go(su.id, d.id)} className={`nav-row${active ? ' active' : ''}`} style={{ ...rowBtn, paddingLeft: 52, fontSize: 13, fontWeight: active ? 600 : 450 }}>
                                <span style={{ ...dot, background: active ? 'var(--brand)' : 'rgba(0,0,0,0.18)' }} />
                                <span style={ellip}>{d.title}</span>
                              </button>
                            );
                          })}
                          {set.dashboards.length === 0 && <div style={{ ...subRow, paddingLeft: 52, color: 'var(--muted)' }}>No dashboards</div>}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        ))
      )}
    </nav>
  );

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative' }}>
      {/* Desktop: sidebar always mounted, width-animates to 0 when collapsed.
          Mobile: a drawer. */}
      {!isMobile && <div className={`sidebar-wrap${collapsed ? ' collapsed' : ''}`}>{sidebar}</div>}
      {isMobile && navOpen && (
        <div style={{ position: 'fixed', inset: 0, top: 56, zIndex: 50, display: 'flex' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)' }} onClick={() => setNavOpen(false)} />
          {sidebar}
        </div>
      )}
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
        {isAdmin && (
          <div style={previewBar}>
            <span style={{ fontWeight: 700 }}>👁 Client preview{activeEntityId && (() => { const n = suites.find((s) => s.id === suiteId)?.entityName; return n ? ` — ${n}` : ''; })()}</span>
            <span style={{ opacity: 0.85 }}>You're viewing this exactly as the client would, scoped to their data.</span>
            <div style={{ flex: 1 }} />
            <button style={exitPreviewBtn} onClick={() => navigate('/admin')}>Exit preview</button>
          </div>
        )}
        {(isMobile || collapsed) && (
          <div style={menuBar}>
            <button style={menuBtn} onClick={() => (isMobile ? setNavOpen(true) : toggleCollapsed())}>☰&nbsp; Menu</button>
            {activeTitle && <span style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeTitle}</span>}
          </div>
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
const brandHeader = { display: 'flex', alignItems: 'center', gap: 9, padding: '4px 12px 14px', marginBottom: 4, borderBottom: '1px solid var(--hairline)' };
const mobileSidebar = { position: 'relative', zIndex: 51, height: '100%', width: 'min(290px, 84vw)', boxShadow: '4px 0 24px rgba(0,0,0,0.15)', WebkitOverflowScrolling: 'touch' };
const menuBar = { position: 'sticky', top: 0, zIndex: 20, display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: '1px solid var(--hairline)', background: 'var(--frost)', backdropFilter: 'saturate(180%) blur(20px)', WebkitBackdropFilter: 'saturate(180%) blur(20px)' };
const rowBtn = { display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', padding: '8px 12px', borderRadius: 9, fontSize: 14, color: 'var(--text)', lineHeight: 1.3 };
const subRow = { padding: '7px 12px', fontSize: 13 };
const ellip = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const dot = { flexShrink: 0, width: 5, height: 5, borderRadius: '50%', display: 'inline-block' };
const menuBtn = { flexShrink: 0, padding: '8px 16px', borderRadius: 980, border: '1px solid var(--hairline)', background: 'var(--card)', fontSize: 14, fontWeight: 600, cursor: 'pointer' };
const previewBar = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 16px', background: 'linear-gradient(90deg, #FF385C, #FF6B35)', color: '#fff', fontSize: 13 };
const exitPreviewBtn = { flexShrink: 0, padding: '6px 14px', borderRadius: 980, border: 'none', background: 'rgba(255,255,255,0.25)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' };
const iconBtn = { width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--hairline)', borderRadius: 7, background: 'var(--card)', color: 'var(--muted-2)', fontSize: 12, cursor: 'pointer' };
