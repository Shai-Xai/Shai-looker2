import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { Outlet, useParams, useNavigate, useLocation } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useAuth } from '../lib/auth.jsx';
import { useProfile } from '../lib/profile.jsx';
import { useTheme } from '../lib/theme.jsx';
import { vtNavigate } from '../lib/viewTransition.js';
import { useSheetDrag } from '../lib/useSheetDrag.js';
import { applyBrand, resetBrand } from '../lib/brand.js';
import { pushSupported, isSubscribed, enablePush, disablePush } from '../lib/push.js';

// Persistent client shell: a left sidebar tree of Suites → Sets → Dashboards,
// with the selected dashboard rendered in the main area.
export default function ClientLayout() {
  const { suiteId, id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const { user, isAdmin } = useAuth();
  const [suites, setSuites] = useState([]);
  const [settlements, setSettlements] = useState([]);
  const [details, setDetails] = useState({}); // suiteId -> { sets:[{id,name,dashboards}] }
  // Expanded state survives reloads — the tree reopens the way you left it.
  const [openSuites, setOpenSuites] = useState(() => readJson('howler_nav_open_suites'));
  const [openSets, setOpenSets] = useState(() => readJson('howler_nav_open_sets'));
  useEffect(() => { localStorage.setItem('howler_nav_open_suites', JSON.stringify(openSuites)); }, [openSuites]);
  useEffect(() => { localStorage.setItem('howler_nav_open_sets', JSON.stringify(openSets)); }, [openSets]);
  const [q, setQ] = useState(''); // sidebar search
  const searching = q.trim().length > 0;
  const [loading, setLoading] = useState(true);
  const [navOpen, setNavOpen] = useState(false); // mobile drawer
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('howler_nav_collapsed') === '1'); // desktop
  const toggleCollapsed = () => setCollapsed((c) => { localStorage.setItem('howler_nav_collapsed', c ? '0' : '1'); return !c; });
  const navDrag = useSheetDrag(() => setNavOpen(false)); // mobile bottom-sheet dismiss
  // The dashboard page (ViewPage) portals its actions into the menu bar so
  // Summary / Filters / ⋯ sit on the ☰ Menu line, not a separate row below.
  const [actionsSlot, setActionsSlot] = useState(null);

  useEffect(() => { api.mySuites().then(setSuites).catch(() => {}).finally(() => setLoading(false)); }, []);
  useEffect(() => { api.mySettlements().then(setSettlements).catch(() => {}); }, []);
  const onSettlements = location.pathname.startsWith('/settlements');
  const onInbox = location.pathname.startsWith('/inbox');
  const onDigests = location.pathname.startsWith('/digests');
  const onActions = location.pathname.startsWith('/actions');

  // Experience OS inbox: unread + must-acknowledge counts for the badge/banner.
  const [inbox, setInbox] = useState({ enabled: false, unread: 0, pending: [] });

  async function ensureDetail(sid) {
    if (details[sid]) return;
    const d = await api.mySuite(sid).catch(() => null);
    if (d) setDetails((prev) => ({ ...prev, [sid]: d }));
  }
  function toggleSuite(sid) {
    setOpenSuites((p) => ({ ...p, [sid]: !p[sid] }));
    ensureDetail(sid);
  }

  // Hydrate details for suites that were left open, and for everything once a
  // search starts (search needs every suite's tree to match against).
  useEffect(() => {
    for (const su of suites) if (openSuites[su.id] || searching) ensureDetail(su.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suites, searching]);

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
    for (const set of d.sets) {
      if (set.dashboards.some((x) => x.id === id || (x.children || []).some((c) => c.id === id))) {
        setOpenSets((p) => ({ ...p, [set.id]: true }));
      }
    }
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
  }, [id, suiteId, openSuites, openSets, details, collapsed, loading, isMobile, navOpen, location.pathname, settlements, q]);

  // Title of the active dashboard (for the mobile menu bar) — may be a tab.
  let activeTitle = '';
  const cur = details[suiteId];
  if (cur && id) {
    outer: for (const set of cur.sets) {
      for (const dash of set.dashboards) {
        if (dash.id === id) { activeTitle = dash.title; break outer; }
        const child = (dash.children || []).find((c) => c.id === id);
        if (child) { activeTitle = child.title; break outer; }
      }
    }
  }

  // When an admin previews, scope EVERYTHING to the previewed client (entity) so
  // the preview faithfully shows that one account, not every client. The active
  // suite tells us the entity; we remember it (sessionStorage) so pages without
  // a suite in the URL — settlements, documents — stay scoped too.
  const suiteEntityId = isAdmin && suiteId ? suites.find((s) => s.id === suiteId)?.entityId : null;
  const [previewEntityId, setPreviewEntityId] = useState(() => sessionStorage.getItem('howler_preview_entity') || null);
  useEffect(() => {
    if (suiteEntityId && suiteEntityId !== previewEntityId) {
      sessionStorage.setItem('howler_preview_entity', suiteEntityId);
      setPreviewEntityId(suiteEntityId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suiteEntityId]);
  // A login can hold several client profiles. The active one (shared context,
  // switched from the top-header identity) drives the whole shell — nav, theme,
  // home, digests, actions — and persists across visits. An admin in the console
  // who opens a suite is "previewing"; an admin who switched INTO a client
  // account (mode 'client') is acting as that client (no preview banner).
  const { activeEntityId: profileEntityId, mode: profileMode } = useProfile();
  const previewMode = isAdmin && profileMode === 'console';
  const activeEntityId = isAdmin
    ? (previewMode ? (suiteEntityId || previewEntityId) : (suiteEntityId || profileEntityId))
    : profileEntityId;
  const visibleSuites = activeEntityId ? suites.filter((s) => s.entityId === activeEntityId) : suites;
  const visibleSettlements = activeEntityId ? settlements.filter((s) => s.entityId === activeEntityId) : settlements;

  // Experience OS inbox badge/banner — scoped to the ACTIVE profile so a
  // multi-profile login only sees the current client's messages (re-polls when
  // you switch profile). Admin console (no active entity) sees all.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await api.osInbox(activeEntityId || undefined);
        // Campaigns awaiting this client's go-ahead also count toward the badge.
        let pendingApproval = 0;
        if (activeEntityId) { try { pendingApproval = (await api.getActionsSummary(activeEntityId)).pendingApproval || 0; } catch { /* ignore */ } }
        if (!alive) return;
        setInbox((s) => ({ ...s, enabled: true, unread: r.unread, pendingApproval, pending: r.threads.filter((t) => t.priority === 'must_ack' && !t.acked) }));
        // Mirror unread + pending approvals onto the installed app's icon badge.
        const total = (r.unread || 0) + pendingApproval;
        try { if (navigator.setAppBadge) { total ? navigator.setAppBadge(total) : navigator.clearAppBadge(); } } catch { /* unsupported */ }
      } catch { /* ignore */ }
    };
    poll();
    const t = setInterval(poll, 60000); // light poll; webhook push later
    window.addEventListener('os-refresh', poll); // instant update after ack/reply
    return () => { alive = false; clearInterval(t); window.removeEventListener('os-refresh', poll); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, activeEntityId]);

  // White-label: apply the active client's brand pair (primary + secondary) to
  // the whole shell — UI accents AND chart palettes follow it. Clients theme to
  // their own entity; an admin preview themes to the previewed client (faithful
  // preview). Reverts to Howler on unmount / when no entity is in context.
  const themeEntityId = activeEntityId;
  useEffect(() => {
    let alive = true;
    if (!themeEntityId) { resetBrand(); return; }
    api.getEntityTheme(themeEntityId)
      .then((t) => { if (alive) applyBrand(t); })
      .catch(() => { if (alive) resetBrand(); });
    return () => { alive = false; resetBrand(); };
  }, [themeEntityId]);

  // Mobile sheet skips the suite level for single-suite clients — make sure
  // that suite's detail is loaded the moment the sheet opens.
  useEffect(() => {
    if (isMobile && navOpen && visibleSuites.length === 1) ensureDetail(visibleSuites[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, navOpen, visibleSuites.length]);

  // When the visible suites all belong to one client, show that client's brand
  // (logo / name) at the top of the sidebar.
  const uniqueEntityIds = [...new Set(visibleSuites.map((s) => s.entityId))];
  const brand = uniqueEntityIds.length === 1 ? visibleSuites.find((s) => s.entityId === uniqueEntityIds[0]) : null;

  // Sidebar search: filters suites → sets → dashboards (including tab titles).
  // Returns the sets to render for a suite; null hides the suite, undefined
  // means "matches but still loading".
  const ql = q.trim().toLowerCase();
  const hit = (s) => String(s || '').toLowerCase().includes(ql);
  const suiteSets = (su) => {
    const det = details[su.id];
    if (!searching) return det ? det.sets : undefined;
    if (hit(su.name)) return det ? det.sets : undefined;
    if (!det) return null;
    const sets = det.sets.map((set) => {
      if (hit(set.name)) return set;
      const dashboards = set.dashboards.filter((d) => hit(d.title) || (d.children || []).some((c) => hit(c.title)));
      return dashboards.length ? { ...set, dashboards } : null;
    }).filter(Boolean);
    return sets.length ? sets : null;
  };
  const shownSuites = searching ? visibleSuites.filter((su) => suiteSets(su) !== null) : visibleSuites;

  // Shell = frosted column: scrollable tree on top, profile pinned at bottom.
  const sidebar = (
    <div className="howler-sidebar" style={{ ...sidebarShell, ...(isMobile ? mobileSidebar : null) }}>
    <nav ref={navRef} style={sidebarStyle}>
      <div className="nav-indicator" style={{ transform: `translateY(${indicator.y}px)`, height: indicator.h, opacity: indicator.show ? 1 : 0 }} />
      <div style={searchWrap}>
        <span style={{ color: 'var(--muted)', fontSize: 13, flexShrink: 0 }}>⌕</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search dashboards…" style={searchInput} />
        {searching && <button onClick={() => setQ('')} style={searchClear} aria-label="Clear search">✕</button>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', padding: '2px 8px 10px 14px' }}>
        <span style={{ flex: 1, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>Suites</span>
        {!isMobile && <button onClick={toggleCollapsed} title="Collapse sidebar" style={iconBtn}>⟨</button>}
      </div>
      {loading ? (
        <div style={{ padding: 14, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
      ) : visibleSuites.length === 0 ? (
        <div style={{ padding: 14, color: 'var(--muted)', fontSize: 13 }}>No suites assigned.</div>
      ) : searching && shownSuites.length === 0 ? (
        <div style={{ padding: 14, color: 'var(--muted)', fontSize: 13 }}>No matches for “{q.trim()}”.</div>
      ) : (
        shownSuites.map((su) => {
          const sets = suiteSets(su);
          const suiteOpen = searching || !!openSuites[su.id];
          return (
            <div key={su.id} style={{ marginBottom: 2 }}>
              <button className="nav-row" style={{ ...rowBtn, fontWeight: 600 }} onClick={() => toggleSuite(su.id)}>
                <Caret open={suiteOpen} />
                <Ico v={su.icon} size={22} />
                <span style={ellip}>{su.name}</span>
              </button>
              <div className={`collapsey${suiteOpen ? ' open' : ''}`}>
                <div className="collapsey-inner" style={{ marginTop: 1 }}>
                  {sets === undefined ? (
                    suiteOpen && <div style={{ ...subRow, color: 'var(--muted)' }}>Loading…</div>
                  ) : (sets || []).length === 0 ? (
                    <div style={{ ...subRow, color: 'var(--muted)' }}>No sets</div>
                  ) : (
                    sets.map((set) => {
                      const setOpen = searching || !!openSets[set.id];
                      return (
                        <div key={set.id}>
                          <button className="nav-row" style={{ ...rowBtn, padding: '7px 12px 7px 28px', fontWeight: 500, fontSize: 13, color: 'var(--muted-2)' }} onClick={() => setOpenSets((p) => ({ ...p, [set.id]: !p[set.id] }))}>
                            <Caret open={setOpen} small />
                            <Ico v={set.icon} size={15} />
                            <span style={ellip}>{set.name}</span>
                          </button>
                          <div className={`collapsey${setOpen ? ' open' : ''}`}>
                            <div className="collapsey-inner">
                              {set.dashboards.map((d) => {
                                const tabs = d.children?.length || 0;
                                const active = (d.id === id || (d.children || []).some((c) => c.id === id)) && su.id === suiteId;
                                return (
                                  <button key={d.id} ref={active ? activeRef : null} onClick={() => go(su.id, d.id)} className={`nav-row${active ? ' active' : ''}`} style={{ ...rowBtn, padding: '6px 12px 6px 50px', fontSize: 13, fontWeight: active ? 600 : 450 }}>
                                    <span style={{ ...dot, background: active ? 'var(--brand)' : 'rgba(0,0,0,0.18)' }} />
                                    <span style={ellip}>{d.title}</span>
                                    {tabs > 0 && <span style={tabChip} title={`${tabs + 1} tabs inside`}>{tabs + 1}</span>}
                                  </button>
                                );
                              })}
                              {set.dashboards.length === 0 && <div style={{ ...subRow, paddingLeft: 50, color: 'var(--muted)' }}>No dashboards</div>}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          );
        })
      )}
      {/* Settlements — its own section below the suites. Hidden for clients
          with no reports; admins always see it (to preview the feature). */}
      {(
        <>
          <div style={{ borderTop: '1px solid var(--hairline)', margin: '12px 6px 10px' }} />
          <div style={{ padding: '0 8px 8px 14px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>Workspace</div>
          {(visibleSettlements.length > 0 || isAdmin) && (
          <button
            ref={onSettlements ? activeRef : null}
            className={`nav-row${onSettlements ? ' active' : ''}`}
            style={{ ...rowBtn, fontWeight: onSettlements ? 600 : 500 }}
            onClick={() => { if (!onSettlements) vtNavigate(navigate, '/settlements'); if (isMobile) setNavOpen(false); }}
          >
            <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>🧾</span>
            <span style={ellip}>Settlements</span>
            {visibleSettlements.length > 0 && <span style={countChip}>{visibleSettlements.length}</span>}
          </button>
          )}
          {inbox.enabled && (
            <button
              className={`nav-row${onInbox ? ' active' : ''}`}
              style={{ ...rowBtn, fontWeight: onInbox ? 600 : 500 }}
              onClick={() => { if (!onInbox) vtNavigate(navigate, '/inbox'); if (isMobile) setNavOpen(false); }}
            >
              <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>📥</span>
              <span style={ellip}>Inbox</span>
              {inbox.unread > 0 && <span style={{ ...countChip, background: 'var(--brand)', color: '#fff' }}>{inbox.unread}</span>}
            </button>
          )}
          <button
            ref={onDigests ? activeRef : null}
            className={`nav-row${onDigests ? ' active' : ''}`}
            style={{ ...rowBtn, fontWeight: onDigests ? 600 : 500 }}
            onClick={() => { if (!onDigests) vtNavigate(navigate, '/digests'); if (isMobile) setNavOpen(false); }}
          >
            <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>🗓</span>
            <span style={ellip}>Digests</span>
          </button>
          <button
            ref={onActions ? activeRef : null}
            className={`nav-row${onActions ? ' active' : ''}`}
            style={{ ...rowBtn, fontWeight: onActions ? 600 : 500 }}
            onClick={() => { if (!onActions) vtNavigate(navigate, '/actions'); if (isMobile) setNavOpen(false); }}
          >
            <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>⚡</span>
            <span style={ellip}>Actions</span>
          </button>
        </>
      )}
    </nav>
    <ProfileFooter
      user={user}
      isAdmin={isAdmin}
      brand={brand}
      onNavigate={(path) => { navigate(path); if (isMobile) setNavOpen(false); }}
    />
    </div>
  );

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative' }}>
      {/* Desktop: sidebar always mounted, width-animates to 0 when collapsed.
          Mobile: a drawer. */}
      {!isMobile && <div className={`sidebar-wrap${collapsed ? ' collapsed' : ''}`}>{sidebar}</div>}
      {/* Mobile: navigation is a bottom sheet (same language as the filters) —
          thumb-reachable, drag-to-dismiss, bigger touch targets. With a single
          suite the suite level is skipped entirely. */}
      {isMobile && navOpen && (
        <div className="ai-overlay" style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'flex-end' }} onClick={() => setNavOpen(false)}>
          <div className="ai-sheet" style={{ ...navSheet, ...navDrag.style }} onClick={(e) => e.stopPropagation()}>
            <div className="sheet-grip" {...navDrag.handlers} style={{ marginTop: 10 }} />
            <div style={{ padding: '2px 14px 8px' }}>
              <div style={searchWrap}>
                <span style={{ color: 'var(--muted)', fontSize: 13, flexShrink: 0 }}>⌕</span>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search dashboards…" style={searchInput} />
                {searching && <button onClick={() => setQ('')} style={searchClear} aria-label="Clear search">✕</button>}
              </div>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '0 10px 8px' }}>
              {searching && shownSuites.length === 0 && (
                <div style={{ padding: 14, color: 'var(--muted)', fontSize: 13 }}>No matches for “{q.trim()}”.</div>
              )}
              {shownSuites.map((su) => {
                const sets = suiteSets(su);
                const single = shownSuites.length === 1;
                const suiteOpen = single || searching || !!openSuites[su.id];
                return (
                  <div key={su.id}>
                    {!single && (
                      <button className="nav-row" style={mRowSuite} onClick={() => toggleSuite(su.id)}>
                        <Caret open={suiteOpen} />
                        <Ico v={su.icon} size={22} />
                        <span style={ellip}>{su.name}</span>
                      </button>
                    )}
                    {suiteOpen && (
                      sets === undefined ? (
                        <div style={{ padding: '8px 14px', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
                      ) : (
                        (sets || []).map((set) => {
                          const setOpen = searching || !!openSets[set.id];
                          return (
                            <div key={set.id}>
                              <button className="nav-row" style={{ ...mRowSet, paddingLeft: single ? 12 : 26 }} onClick={() => setOpenSets((p) => ({ ...p, [set.id]: !p[set.id] }))}>
                                <Caret open={setOpen} small />
                                <Ico v={set.icon} size={17} />
                                <span style={ellip}>{set.name}</span>
                              </button>
                              {setOpen && set.dashboards.map((d) => {
                                const tabs = d.children?.length || 0;
                                const active = (d.id === id || (d.children || []).some((c) => c.id === id)) && su.id === suiteId;
                                return (
                                  <button key={d.id} onClick={() => go(su.id, d.id)} className={`nav-row${active ? ' active' : ''}`} style={{ ...mRowDash, paddingLeft: single ? 34 : 48, fontWeight: active ? 700 : 450 }}>
                                    <span style={{ ...dot, background: active ? 'var(--brand)' : 'rgba(128,128,128,0.35)' }} />
                                    <span style={ellip}>{d.title}</span>
                                    {tabs > 0 && <span style={tabChip}>{tabs + 1}</span>}
                                  </button>
                                );
                              })}
                            </div>
                          );
                        })
                      )
                    )}
                  </div>
                );
              })}
              {(
                <>
                  <div style={{ borderTop: '1px solid var(--hairline)', margin: '10px 4px' }} />
                  {(visibleSettlements.length > 0 || isAdmin) && (
                  <button
                    className={`nav-row${onSettlements ? ' active' : ''}`}
                    style={{ ...mRowSuite, fontWeight: onSettlements ? 700 : 500 }}
                    onClick={() => { if (!onSettlements) vtNavigate(navigate, '/settlements'); setNavOpen(false); }}
                  >
                    <span style={{ fontSize: 17, lineHeight: 1, flexShrink: 0 }}>🧾</span>
                    <span style={ellip}>Settlements</span>
                    {visibleSettlements.length > 0 && <span style={countChip}>{visibleSettlements.length}</span>}
                  </button>
                  )}
                  {inbox.enabled && (
                    <button
                      className={`nav-row${onInbox ? ' active' : ''}`}
                      style={{ ...mRowSuite, fontWeight: onInbox ? 700 : 500 }}
                      onClick={() => { if (!onInbox) vtNavigate(navigate, '/inbox'); setNavOpen(false); }}
                    >
                      <span style={{ fontSize: 17, lineHeight: 1, flexShrink: 0 }}>📥</span>
                      <span style={ellip}>Inbox</span>
                      {inbox.unread > 0 && <span style={{ ...countChip, background: 'var(--brand)', color: '#fff' }}>{inbox.unread}</span>}
                    </button>
                  )}
                  <button
                    className={`nav-row${onDigests ? ' active' : ''}`}
                    style={{ ...mRowSuite, fontWeight: onDigests ? 700 : 500 }}
                    onClick={() => { if (!onDigests) vtNavigate(navigate, '/digests'); setNavOpen(false); }}
                  >
                    <span style={{ fontSize: 17, lineHeight: 1, flexShrink: 0 }}>🗓</span>
                    <span style={ellip}>Digests</span>
                  </button>
                  <button
                    className={`nav-row${onActions ? ' active' : ''}`}
                    style={{ ...mRowSuite, fontWeight: onActions ? 700 : 500 }}
                    onClick={() => { if (!onActions) vtNavigate(navigate, '/actions'); setNavOpen(false); }}
                  >
                    <span style={{ fontSize: 17, lineHeight: 1, flexShrink: 0 }}>⚡</span>
                    <span style={ellip}>Actions</span>
                  </button>
                </>
              )}
            </div>
            <ProfileFooter
              user={user}
              isAdmin={isAdmin}
              brand={brand}
              onNavigate={(path) => { navigate(path); setNavOpen(false); }}
            />
          </div>
        </div>
      )}
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
        {/* Must-acknowledge banner — Howler messages that need a response,
            persistent until acknowledged. Tapping opens the inbox. */}
        {!onInbox && inbox.pending.length > 0 && (
          <button
            onClick={() => vtNavigate(navigate, '/inbox')}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', border: 'none', cursor: 'pointer', textAlign: 'left', padding: '10px 16px', background: 'linear-gradient(90deg, var(--brand), var(--brand-2))', color: '#fff', fontSize: 13 }}
          >
            <span style={{ fontSize: 15 }}>📣</span>
            <span style={{ fontWeight: 700 }}>{inbox.pending.length === 1 ? 'A message from Howler needs your acknowledgement' : `${inbox.pending.length} messages from Howler need your acknowledgement`}</span>
            {inbox.pending[0]?.title && inbox.pending.length === 1 && <span style={{ opacity: 0.9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>— {inbox.pending[0].title}</span>}
            <span style={{ flex: 1 }} />
            <span style={{ background: 'rgba(255,255,255,0.25)', borderRadius: 980, padding: '5px 14px', fontWeight: 700, flexShrink: 0 }}>Open →</span>
          </button>
        )}
        {previewMode && (
          <div style={previewBar}>
            <span style={{ fontWeight: 700 }}>👁 Client preview{activeEntityId && (() => { const n = suites.find((s) => s.entityId === activeEntityId)?.entityName; return n ? ` — ${n}` : ''; })()}</span>
            <span style={{ opacity: 0.85 }}>You're viewing this exactly as the client would, scoped to their data.</span>
            <div style={{ flex: 1 }} />
            <button style={exitPreviewBtn} onClick={() => navigate('/admin')}>Exit preview</button>
          </div>
        )}
        {(isMobile || collapsed) && (
          <div style={menuBar}>
            <button style={menuBtn} onClick={() => (isMobile ? setNavOpen(true) : toggleCollapsed())} title="Menu" aria-label="Open menu">☰</button>
            {activeTitle && <span style={{ flex: 1, fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeTitle}</span>}
            {/* Page (dashboard) actions portal in here — Summary · Filters · ⋯ */}
            <div ref={setActionsSlot} style={{ display: 'flex', alignItems: 'center', gap: 7, marginLeft: 'auto', flexShrink: 0 }} />
          </div>
        )}
        <Outlet context={{ previewEntityId: activeEntityId, actionsSlot }} />
      </main>
    </div>
  );
}

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
}

// Bottom-left profile: avatar + identity, opening a menu with Integrations
// (clients), the theme toggle and Log out — everything that used to crowd the
// top header.
function ProfileFooter({ user, isAdmin, brand, onNavigate }) {
  const { theme, toggle } = useTheme();
  const { logout } = useAuth();
  const [open, setOpen] = useState(false);
  // Notification channel preferences: account-level (email/push prefs) + this
  // device's push subscription (push needs both the pref on AND this device
  // subscribed). busy holds which row is mid-flight; testing for the test send.
  const [notif, setNotif] = useState({ supported: false, pushAvailable: false, email: true, push: false, deviceOn: false, busy: '', testing: false });
  const entity = user?.entities?.[0];
  const name = isAdmin ? 'Howler · Admin' : (brand?.entityName || entity?.name || (user?.email || '').split('@')[0]);
  const logo = brand?.entityLogo || entity?.logo || '';
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      const supported = pushSupported();
      const [prefs, deviceOn] = await Promise.all([
        api.getNotifPrefs().catch(() => ({ email: true, push: true, pushAvailable: false })),
        supported ? isSubscribed() : Promise.resolve(false),
      ]);
      if (alive) setNotif((s) => ({ ...s, supported, pushAvailable: !!prefs.pushAvailable, email: prefs.email !== false, push: prefs.push !== false, deviceOn }));
    })();
    return () => { alive = false; };
  }, [open]);
  const toggleEmail = async () => {
    const next = !notif.email;
    setNotif((s) => ({ ...s, busy: 'email', email: next }));
    try { await api.setNotifPrefs({ email: next }); } catch { setNotif((s) => ({ ...s, email: !next })); }
    setNotif((s) => ({ ...s, busy: '' }));
  };
  // iOS only delivers web push to the installed (Home Screen) app, never a
  // Safari tab — so in Safari we guide instead of showing a toggle that lies.
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  const iosNeedsInstall = isIOS && !standalone;
  const togglePush = async () => {
    const turningOn = !(notif.push && notif.deviceOn);
    setNotif((s) => ({ ...s, busy: 'push' }));
    try {
      if (turningOn) { await enablePush(); await api.setNotifPrefs({ push: true }); setNotif((s) => ({ ...s, push: true, deviceOn: true, busy: '' })); }
      else { await disablePush(); await api.setNotifPrefs({ push: false }); setNotif((s) => ({ ...s, push: false, deviceOn: false, busy: '' })); }
    } catch (e) {
      setNotif((s) => ({ ...s, busy: '' }));
      const iosNotInstalled = /iPhone|iPad/.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches;
      alert(iosNotInstalled
        ? 'On iPhone/iPad, first tap the Share button and "Add to Home Screen", then open Pulse from your home screen to enable notifications.'
        : (e.message || 'Could not enable notifications.'));
    }
  };
  return (
    <div style={{ position: 'relative', borderTop: '1px solid var(--hairline)', padding: 8, flexShrink: 0 }}>
      {open && <div style={{ position: 'fixed', inset: 0, zIndex: 70 }} onClick={() => setOpen(false)} />}
      {open && (
        <div className="modal-in" style={profileMenu}>
          {!isAdmin && (
            <button className="nav-row" style={menuItem} onClick={() => { setOpen(false); onNavigate('/settings'); }}>
              <span style={menuIco}>⚙</span> Settings
            </button>
          )}
          <div style={menuCap}>Notifications</div>
          <button className="nav-row" style={menuItem} onClick={toggleEmail} disabled={notif.busy === 'email'}>
            <span style={menuIco}>✉️</span>
            <span style={{ flex: 1, textAlign: 'left' }}>Email</span>
            <Switch on={notif.email} busy={notif.busy === 'email'} />
          </button>
          {notif.pushAvailable && iosNeedsInstall ? (
            // iOS Safari can't receive push — only the installed app can. Don't
            // show a toggle that would lie; guide them to install instead.
            <button className="nav-row" style={{ ...menuItem, alignItems: 'flex-start' }} onClick={() => alert('To get push notifications on iPhone/iPad:\n\n1. Tap the Share button\n2. Choose “Add to Home Screen”\n3. Open Pulse from the new icon\n\nThen turn on Push from this menu.')}>
              <span style={menuIco}>🔔</span>
              <span style={{ flex: 1, textAlign: 'left' }}>Push<div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>Add Pulse to your Home Screen to enable</div></span>
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>ⓘ</span>
            </button>
          ) : notif.supported && notif.pushAvailable ? (
            <button className="nav-row" style={menuItem} onClick={togglePush} disabled={notif.busy === 'push'}>
              <span style={menuIco}>🔔</span>
              <span style={{ flex: 1, textAlign: 'left' }}>Push (this device)</span>
              <Switch on={notif.push && notif.deviceOn} busy={notif.busy === 'push'} />
            </button>
          ) : null}
          {notif.supported && notif.pushAvailable && notif.push && notif.deviceOn && !iosNeedsInstall && (
            <button className="nav-row" style={{ ...menuItem, fontSize: 12, color: 'var(--muted)' }} disabled={notif.testing} onClick={async () => {
              setNotif((s) => ({ ...s, testing: true }));
              try {
                const r = await api.pushTest();
                alert(r.sent
                  ? `Sent to ${r.sent} device${r.sent === 1 ? '' : 's'} ✓\n\nIf you don't see it, lock your phone or switch apps — iOS hides the banner while Pulse is open.`
                  : 'No devices are registered yet. Turn Push off and on again on the installed app.');
              } catch { alert('Test failed — try turning Push off and on again.'); }
              setNotif((s) => ({ ...s, testing: false }));
            }}>
              <span style={menuIco}>📨</span> {notif.testing ? 'Sending…' : 'Send a test notification'}
            </button>
          )}
          <div style={menuDivider} />
          <button className="nav-row" style={menuItem} onClick={toggle}>
            <span style={menuIco}>{theme === 'dark' ? '☀️' : '🌙'}</span> {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
          <button className="nav-row" style={{ ...menuItem, color: 'var(--error)' }} onClick={() => logout()}>
            <span style={menuIco}>↪</span> Log out
          </button>
        </div>
      )}
      <button className="nav-row" style={profileRow} onClick={() => setOpen((v) => !v)} title="Profile & settings">
        {logo ? (
          <img src={logo} alt="" style={{ width: 30, height: 30, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
        ) : (
          <span style={avatar}>{initial}</span>
        )}
        <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
          <span style={{ display: 'block', fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
          <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.email}</span>
        </span>
        <span style={{ color: 'var(--muted)', fontSize: 14, flexShrink: 0 }}>⋯</span>
      </button>
    </div>
  );
}

// Small iOS-style on/off pill used in the notifications preferences.
function Switch({ on, busy }) {
  return (
    <span style={{ width: 34, height: 20, borderRadius: 999, background: on ? 'var(--brand)' : 'rgba(128,128,128,0.35)', position: 'relative', flexShrink: 0, transition: 'background 0.15s', opacity: busy ? 0.5 : 1 }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 16 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.15s', boxShadow: '0 1px 2px rgba(0,0,0,0.3)' }} />
    </span>
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

const sidebarShell = { width: 264, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0 };
const sidebarStyle = { flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 10px', position: 'relative' };
const profileRow = { display: 'flex', alignItems: 'center', gap: 9, width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', padding: '8px 10px', borderRadius: 10, color: 'var(--text)' };
const avatar = { flexShrink: 0, width: 30, height: 30, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 800, color: '#fff', background: 'linear-gradient(135deg, var(--brand) 0%, var(--brand-2) 45%, #7C3AED 100%)' };
const profileMenu = { position: 'absolute', bottom: 'calc(100% + 6px)', left: 8, right: 8, zIndex: 71, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 10px 36px -8px rgba(0,0,0,0.25)', padding: 6, display: 'flex', flexDirection: 'column', gap: 2 };
const menuItem = { display: 'flex', alignItems: 'center', gap: 9, width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', padding: '9px 10px', borderRadius: 8, fontSize: 13, fontWeight: 600, color: 'var(--text)', textAlign: 'left' };
const menuIco = { width: 18, textAlign: 'center', fontSize: 14, flexShrink: 0 };
const menuCap = { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--muted)', padding: '6px 10px 2px' };
const menuDivider = { height: 1, background: 'var(--hairline)', margin: '5px 6px' };
const mobileSidebar = { position: 'relative', zIndex: 51, height: '100%', width: 'min(290px, 84vw)', boxShadow: '4px 0 24px rgba(0,0,0,0.15)', WebkitOverflowScrolling: 'touch' };
const menuBar = { position: 'sticky', top: 0, zIndex: 20, display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: '1px solid var(--hairline)', background: 'var(--frost)', backdropFilter: 'saturate(180%) blur(20px)', WebkitBackdropFilter: 'saturate(180%) blur(20px)' };
const rowBtn = { display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', padding: '8px 12px', borderRadius: 9, fontSize: 14, color: 'var(--text)', lineHeight: 1.3 };
const subRow = { padding: '7px 12px', fontSize: 13 };
const ellip = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const dot = { flexShrink: 0, width: 5, height: 5, borderRadius: '50%', display: 'inline-block' };
const countChip = { flexShrink: 0, marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, background: 'rgba(128,128,128,0.18)', color: 'var(--muted-2)', borderRadius: 980, minWidth: 18, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px' };
const tabChip = { flexShrink: 0, marginLeft: 'auto', fontSize: 10, fontWeight: 700, color: 'var(--ai, #7c3aed)', background: 'var(--ai-bg, rgba(124,58,237,0.10))', borderRadius: 980, padding: '2px 7px' };
const searchWrap = { display: 'flex', alignItems: 'center', gap: 7, background: 'rgba(128,128,128,0.10)', border: '1px solid var(--hairline)', borderRadius: 9, padding: '6px 10px', margin: '0 4px 10px' };
const searchInput = { flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none', fontSize: 13, color: 'var(--text)', fontFamily: 'inherit' };
const searchClear = { flexShrink: 0, border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 };
// Mobile bottom-sheet nav
const navSheet = { width: '100%', maxHeight: '86dvh', background: 'var(--card)', borderRadius: '18px 18px 0 0', display: 'flex', flexDirection: 'column', paddingBottom: 'env(safe-area-inset-bottom)', boxShadow: '0 -10px 40px rgba(0,0,0,0.25)' };
const mRowSuite = { display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', padding: '12px 12px', borderRadius: 11, fontSize: 15, fontWeight: 700, color: 'var(--text)', lineHeight: 1.3 };
const mRowSet = { display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', padding: '11px 12px', borderRadius: 10, fontSize: 14, fontWeight: 600, color: 'var(--muted-2)', lineHeight: 1.3 };
const mRowDash = { display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', padding: '11px 12px', borderRadius: 10, fontSize: 14.5, color: 'var(--text)', lineHeight: 1.3 };
const menuBtn = { flexShrink: 0, width: 36, height: 36, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 980, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 16, lineHeight: 1, cursor: 'pointer' };
const previewBar = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 16px', background: 'linear-gradient(90deg, var(--brand), var(--brand-2))', color: '#fff', fontSize: 13 };
const exitPreviewBtn = { flexShrink: 0, padding: '6px 14px', borderRadius: 980, border: 'none', background: 'rgba(255,255,255,0.25)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' };
const iconBtn = { width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--hairline)', borderRadius: 7, background: 'var(--card)', color: 'var(--muted-2)', fontSize: 12, cursor: 'pointer' };
