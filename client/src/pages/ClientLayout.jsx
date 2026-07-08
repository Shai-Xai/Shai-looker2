import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { Outlet, useParams, useNavigate, useLocation } from 'react-router-dom';
import { api } from '../lib/api.js';
import VersionStamp from '../components/VersionStamp.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useAuth } from '../lib/auth.jsx';
import { useProfile } from '../lib/profile.jsx';
import { useTheme } from '../lib/theme.jsx';
import { vtNavigate } from '../lib/viewTransition.js';
import { useSheetDrag } from '../lib/useSheetDrag.js';
import { applyBrand, resetBrand, useBrandLogo } from '../lib/brand.js';
import { useAccess, PERMS } from '../lib/access.js';
import { useMyFlags, flagOn } from '../lib/flags.js';
import { FEATURES, owlNativeChatEnabled } from '../lib/features.js';
import AnalystDrawer from '../components/AnalystDrawer.jsx';
import OwlChat from '../components/OwlChat.jsx';
import StatusNoticeBanner from '../components/StatusNoticeBanner.jsx';
import { openReport } from '../components/ReportWidget.jsx';
import AiMark from '../components/AiMark.jsx';

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
  const [askOpen, setAskOpen] = useState(false); // Inventive analyst slide-in drawer
  const [prewarmAsk, setPrewarmAsk] = useState(false); // load the analyst on owl hover → instant first open
  // Open the analyst drawer. Best-effort: ask the browser to grant Inventive
  // first-party storage access (so the embed can run at first-party speed) —
  // harmless / silent if unsupported or denied, so it never breaks anything.
  const saTriedRef = useRef(false);
  const openAsk = () => {
    if (!saTriedRef.current) {
      saTriedRef.current = true;
      try { document.requestStorageAccessFor?.('https://app.madeinventive.com').catch(() => {}); } catch { /* ignore */ }
    }
    setPrewarmAsk(true);
    setAskOpen(true);
  };
  // The top-header "Owl Data Analyst" button lives in App.jsx; it opens the drawer
  // via this event (keeps the drawer state here without lifting it up).
  useEffect(() => {
    const h = () => openAsk();
    window.addEventListener('howler:open-analyst', h);
    return () => window.removeEventListener('howler:open-analyst', h);
  }, []);
  // "Make it happen" on a home suggestion hands the campaign build to the Owl:
  // open the native chat and seed it with the goal so it drafts the right audience.
  // Only wired when the native Owl is on — otherwise ClientHome falls back to the
  // campaign editor itself, so this listener never fires for those users.
  const [owlSeed, setOwlSeed] = useState(null);
  useEffect(() => {
    const h = (e) => { if (!owlNativeChatEnabled(user)) return; setOwlSeed(e.detail || null); openAsk(); };
    window.addEventListener('howler:owl-build', h);
    return () => window.removeEventListener('howler:owl-build', h);
  }, [user]);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('howler_nav_collapsed') === '1'); // desktop
  const toggleCollapsed = () => setCollapsed((c) => { localStorage.setItem('howler_nav_collapsed', c ? '0' : '1'); return !c; });
  const navDrag = useSheetDrag(() => setNavOpen(false)); // mobile bottom-sheet dismiss
  // The dashboard page (ViewPage) portals its actions into the menu bar so
  // Summary / Filters / ⋯ sit on the ☰ Menu line, not a separate row below.
  const [actionsSlot, setActionsSlot] = useState(null);
  const [titleSlot, setTitleSlot] = useState(null); // section pages portal their title into the menu bar

  useEffect(() => { api.mySuites().then(setSuites).catch(() => {}).finally(() => setLoading(false)); }, []);
  useEffect(() => { api.mySettlements().then(setSettlements).catch(() => {}); }, []);
  // Event Ops is a per-client pilot: which of my entities have it switched on (gates the nav).
  const [eopEntities, setEopEntities] = useState([]);
  useEffect(() => { api.eventopsEnabled().then((r) => setEopEntities(r.entities || [])).catch(() => {}); }, []);
  const onEventOps = location.pathname.startsWith('/event-ops');
  const onGoals = location.pathname.startsWith('/goals');
  const onAlerts = location.pathname.startsWith('/alerts');
  const onSocial = location.pathname.startsWith('/social');
  const onSettlements = location.pathname.startsWith('/settlements');
  const onInbox = location.pathname.startsWith('/inbox');
  const onDigests = location.pathname.startsWith('/digests');
  const onProduct = location.pathname.startsWith('/product');
  const onJourney = location.pathname.startsWith('/journey');
  // Engage hub tabs: Campaigns (/engage/campaigns, default /engage) + Segments.
  const onSegments = location.pathname.startsWith('/segments') || location.pathname.startsWith('/engage/segments');
  const onActions = (location.pathname.startsWith('/actions') || location.pathname.startsWith('/engage')) && !onSegments;

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
    // Hide the indicator when the active row lives inside a COLLAPSED section
    // (its suite/set is closed) — otherwise it strands itself at the collapsed
    // row's position, overlapping the headers below it.
    for (let el = btn; el && el !== nav; el = el.parentElement) {
      if (el.classList?.contains('collapsey') && !el.classList.contains('open')) {
        setIndicator((i) => ({ ...i, show: false })); return;
      }
    }
    setIndicator({ y: btn.offsetTop, h: btn.offsetHeight, show: true });
  };
  useLayoutEffect(() => {
    measure();
    // Re-measure after the expand/collapse animation settles (positions shift).
    const t = setTimeout(measure, 300);
    return () => clearTimeout(t);
     
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
  const { activeEntityId: profileEntityId, mode: profileMode, enterConsole, active } = useProfile();
  const { can } = useAccess(); // role-gated nav for the active profile (admins: all)
  const previewMode = isAdmin && profileMode === 'console';
  const activeEntityId = isAdmin
    ? (previewMode ? (suiteEntityId || previewEntityId) : (suiteEntityId || profileEntityId))
    : profileEntityId;
  const visibleSuites = activeEntityId ? suites.filter((s) => s.entityId === activeEntityId) : suites;
  // 🚩 Per-client feature flags drive which workspace sections show (server routes enforce too).
  const myFlags = useMyFlags(activeEntityId);
  const fl = (k) => flagOn(myFlags, k);
  const visibleSettlements = activeEntityId ? settlements.filter((s) => s.entityId === activeEntityId) : settlements;
  // Show the Event Ops nav only when the active client has the pilot switched on AND the
  // user may operate it (admins always pass `can`). Server enforces the real boundary.
  const eventopsOn = (activeEntityId ? eopEntities.includes(activeEntityId) : eopEntities.length > 0) && can(PERMS.EVENTOPS_MANAGE);
  // The "Event Ops" role: can operate Event Ops but has no dashboards — show ONLY Event Ops.
  const opsOnly = can(PERMS.EVENTOPS_MANAGE) && !can(PERMS.DASHBOARDS_VIEW) && !isAdmin;
  // Scope options for the Owl picker: the clients (organisers) + events this user
  // can pick. Admins get all; a client gets their own entity/events.
  const owlClients = (() => {
    const m = new Map();
    for (const s of suites) if (s.entityId) m.set(s.entityId, s.entityName || s.entityId);
    for (const e of (user?.entities || [])) m.set(e.id, e.name || e.id);
    return [...m.entries()].map(([id, name]) => ({ id, name }));
  })();
  const owlEvents = suites.map((s) => ({ id: s.id, name: s.name, entityId: s.entityId, onSale: !!s.onSale, hasGoals: !!s.hasGoals }));

  // Experience OS inbox badge/banner — scoped to the ACTIVE profile so a
  // multi-profile login only sees the current client's messages (re-polls when
  // you switch profile). Admin console (no active entity) sees all.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await api.osInbox(activeEntityId || undefined);
        // Campaigns awaiting this client's go-ahead also count toward the badge,
        // and ones awaiting THIS user's sign-off drive the approval banner.
        let pendingApproval = 0; let awaitingMyApproval = { count: 0, first: '' }; let myOutcomes = [];
        if (activeEntityId) { try { const sum = await api.getActionsSummary(activeEntityId); pendingApproval = sum.pendingApproval || 0; awaitingMyApproval = sum.awaitingMyApproval || awaitingMyApproval; myOutcomes = sum.myOutcomes || []; } catch { /* ignore */ } }
        if (!alive) return;
        setInbox((s) => ({ ...s, enabled: true, unread: r.unread, pendingApproval, awaitingMyApproval, myOutcomes, pending: r.threads.filter((t) => t.priority === 'must_ack' && !t.acked) }));
        // Mirror unread + pending approvals onto the installed app's icon badge.
        const total = (r.unread || 0) + pendingApproval;
        try { if (navigator.setAppBadge) { total ? navigator.setAppBadge(total) : navigator.clearAppBadge(); } } catch { /* unsupported */ }
      } catch { /* ignore */ }
    };
    poll();
    const t = setInterval(poll, 20000); // keep the badge fresh
    window.addEventListener('os-refresh', poll); // instant update after ack/reply
    const onVis = () => { if (document.visibilityState === 'visible') poll(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => { alive = false; clearInterval(t); window.removeEventListener('os-refresh', poll); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', onVis); };
     
  }, [location.pathname, activeEntityId]);

  // White-label: apply the active client's brand pair (primary + secondary) to
  // the whole shell — UI accents AND chart palettes follow it. Clients theme to
  // their own entity; an admin preview themes to the previewed client (faithful
  // preview). Reverts to Howler on unmount / when no entity is in context.
  const themeEntityId = activeEntityId;
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (!themeEntityId) { resetBrand(); return; }
      // While viewing an event, theme to that EVENT's branding (its logo/colours,
      // inheriting the client's where unset); the home/portfolio uses the client.
      api.getEntityTheme(themeEntityId, suiteId || '')
        .then((t) => { if (alive) applyBrand(t); })
        .catch(() => { if (alive) resetBrand(); });
    };
    load();
    // Re-pull the moment branding is saved (client or this event), so the shell
    // updates live without a reload.
    const onSaved = (e) => { if (!e.detail || e.detail.entityId === themeEntityId || (e.detail.suiteId && e.detail.suiteId === suiteId)) load(); };
    window.addEventListener('pulse-branding-saved', onSaved);
    return () => { alive = false; resetBrand(); window.removeEventListener('pulse-branding-saved', onSaved); };
  }, [themeEntityId, suiteId]);

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
      {!opsOnly && (
      <div style={searchWrap}>
        <span style={{ color: 'var(--muted)', fontSize: 13, flexShrink: 0 }}>⌕</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search dashboards…" style={searchInput} />
        {searching && <button onClick={() => setQ('')} style={searchClear} aria-label="Clear search">✕</button>}
      </div>
      )}
      {!opsOnly && (
      <div style={{ display: 'flex', alignItems: 'center', padding: '2px 8px 10px 14px' }}>
        <span style={{ flex: 1, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>Suites</span>
        {!isMobile && <button onClick={toggleCollapsed} title="Collapse sidebar" style={iconBtn}>⟨</button>}
      </div>
      )}
      {loading ? (
        <div style={{ padding: 14, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
      ) : opsOnly ? null : visibleSuites.length === 0 ? (
        <div style={{ padding: 14, color: 'var(--muted)', fontSize: 13 }}>No suites assigned.</div>
      ) : searching && shownSuites.length === 0 ? (
        <div style={{ padding: 14, color: 'var(--muted)', fontSize: 13 }}>No matches for “{q.trim()}”.</div>
      ) : (
        shownSuites.map((su) => {
          const sets = suiteSets(su);
          const suiteOpen = searching || !!openSuites[su.id];
          return (
            <div key={su.id} style={{ marginBottom: 2 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <button className="nav-row" style={{ ...rowBtn, fontWeight: 600, flex: 1, minWidth: 0 }} onClick={() => toggleSuite(su.id)}>
                  <Caret open={suiteOpen} />
                  <Ico v={su.icon} size={22} />
                  <span style={ellip}>{su.name}</span>
                </button>
                {su.liveDashboardId && <LiveBtn onClick={() => go(su.id, su.liveDashboardId)} title={`Live ticket sales — ${su.name}`} />}
              </div>
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
          <div style={{ display: 'flex', alignItems: 'center', padding: '0 8px 8px 14px' }}>
            <span style={{ flex: 1, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>Workspace</span>
            {/* Ops-only role has no "Suites" header (where everyone else's collapse
                arrow lives), so surface the collapse control here for them. */}
            {opsOnly && !isMobile && <button onClick={toggleCollapsed} title="Collapse sidebar" style={iconBtn}>⟨</button>}
          </div>
          {!opsOnly && fl('goals') && (visibleSuites.length > 0 || isAdmin) && (
          <button
            ref={onGoals ? activeRef : null}
            className={`nav-row${onGoals ? ' active' : ''}`}
            style={{ ...rowBtn, fontWeight: onGoals ? 600 : 500 }}
            onClick={() => { if (!onGoals) vtNavigate(navigate, '/goals'); if (isMobile) setNavOpen(false); }}
          >
            <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>🎯</span>
            <span style={ellip}>Goals</span>
          </button>
          )}
          {!opsOnly && fl('alerts') && (visibleSuites.length > 0 || isAdmin) && (
          <button
            ref={onAlerts ? activeRef : null}
            className={`nav-row${onAlerts ? ' active' : ''}`}
            style={{ ...rowBtn, fontWeight: onAlerts ? 600 : 500 }}
            onClick={() => { if (!onAlerts) vtNavigate(navigate, '/alerts'); if (isMobile) setNavOpen(false); }}
          >
            <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>🔔</span>
            <span style={ellip}>Alerts</span>
          </button>
          )}
          {eventopsOn && (
          <button
            ref={onEventOps ? activeRef : null}
            className={`nav-row${onEventOps ? ' active' : ''}`}
            style={{ ...rowBtn, fontWeight: onEventOps ? 600 : 500 }}
            onClick={() => { if (!onEventOps) vtNavigate(navigate, '/event-ops'); if (isMobile) setNavOpen(false); }}
          >
            <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>📟</span>
            <span style={ellip}>Event Ops</span>
          </button>
          )}
          {!opsOnly && fl('digests') && can(PERMS.DIGESTS_MANAGE) && (
          <button
            ref={onDigests ? activeRef : null}
            className={`nav-row${onDigests ? ' active' : ''}`}
            style={{ ...rowBtn, fontWeight: onDigests ? 600 : 500 }}
            onClick={() => { if (!onDigests) vtNavigate(navigate, '/digests'); if (isMobile) setNavOpen(false); }}
          >
            <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>🗓</span>
            <span style={ellip}>Digests</span>
          </button>
          )}
          {!opsOnly && fl('settlements') && can(PERMS.SETTLEMENTS_VIEW) && (visibleSettlements.length > 0 || isAdmin) && (
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
          {!opsOnly && inbox.enabled && (
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
          {/* Your journey — stickers, badges & Pulse Points (always reachable,
              even after the Getting-started card retires). */}
          {!opsOnly && (
          <button
            ref={onJourney ? activeRef : null}
            className={`nav-row${onJourney ? ' active' : ''}`}
            style={{ ...rowBtn, fontWeight: onJourney ? 600 : 500 }}
            onClick={() => { if (!onJourney) vtNavigate(navigate, '/journey'); if (isMobile) setNavOpen(false); }}
          >
            <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>⚡</span>
            <span style={ellip}>Your journey</span>
          </button>
          )}
          {/* Product — report bugs/ideas and track them (everyone, incl. ops-only). */}
          {fl('report') && (<>
          <button
            ref={onProduct ? activeRef : null}
            className={`nav-row${onProduct ? ' active' : ''}`}
            style={{ ...rowBtn, fontWeight: onProduct ? 600 : 500 }}
            onClick={() => { if (!onProduct) vtNavigate(navigate, '/product'); if (isMobile) setNavOpen(false); }}
          >
            <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>🎟️</span>
            <span style={ellip}>Product</span>
          </button>
          {/* Report an issue — opens the report modal (replaces the old floating button). */}
          <button
            className="nav-row"
            style={{ ...rowBtn, fontWeight: 500 }}
            onClick={() => { openReport(); if (isMobile) setNavOpen(false); }}
          >
            <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>💬</span>
            <span style={ellip}>Report an issue</span>
          </button>
          </>)}
          {!opsOnly && fl('engage') && (can(PERMS.CAMPAIGNS_VIEW)) && (
          <>
          <div style={{ borderTop: '1px solid var(--hairline)', margin: '12px 6px 10px' }} />
          <div style={{ padding: '0 8px 8px 14px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>Engage</div>
          {fl('engage.campaigns') && (
          <button
            ref={onActions ? activeRef : null}
            className={`nav-row${onActions ? ' active' : ''}`}
            style={{ ...rowBtn, fontWeight: onActions ? 600 : 500 }}
            onClick={() => { if (!onActions) vtNavigate(navigate, '/engage/campaigns'); if (isMobile) setNavOpen(false); }}
          >
            <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>📣</span>
            <span style={ellip}>Campaigns</span>
          </button>
          )}
          {fl('engage.segments') && (
          <button
            ref={onSegments ? activeRef : null}
            className={`nav-row${onSegments ? ' active' : ''}`}
            style={{ ...rowBtn, fontWeight: onSegments ? 600 : 500 }}
            onClick={() => { if (!onSegments) vtNavigate(navigate, '/engage/segments'); if (isMobile) setNavOpen(false); }}
          >
            <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>🥧</span>
            <span style={ellip}>Segments</span>
          </button>
          )}
          {fl('social') && (
          <button
            ref={onSocial ? activeRef : null}
            className={`nav-row${onSocial ? ' active' : ''}`}
            style={{ ...rowBtn, fontWeight: onSocial ? 600 : 500 }}
            onClick={() => { if (!onSocial) vtNavigate(navigate, '/social'); if (isMobile) setNavOpen(false); }}
          >
            <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>📱</span>
            <span style={ellip}>Social</span>
          </button>
          )}
          </>
          )}
        </>
      )}
    </nav>
    <ProfileFooter
      user={user}
      isAdmin={isAdmin}
      activeEntityId={activeEntityId}
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
            {!opsOnly && (
            <div style={{ padding: '2px 14px 8px' }}>
              <div style={searchWrap}>
                <span style={{ color: 'var(--muted)', fontSize: 13, flexShrink: 0 }}>⌕</span>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search dashboards…" style={searchInput} />
                {searching && <button onClick={() => setQ('')} style={searchClear} aria-label="Clear search">✕</button>}
              </div>
            </div>
            )}
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '0 10px 8px' }}>
              {searching && shownSuites.length === 0 && (
                <div style={{ padding: 14, color: 'var(--muted)', fontSize: 13 }}>No matches for “{q.trim()}”.</div>
              )}
              {!opsOnly && shownSuites.map((su) => {
                const sets = suiteSets(su);
                const single = shownSuites.length === 1;
                const suiteOpen = single || searching || !!openSuites[su.id];
                return (
                  <div key={su.id}>
                    {!single && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <button className="nav-row" style={{ ...mRowSuite, flex: 1, minWidth: 0 }} onClick={() => toggleSuite(su.id)}>
                          <Caret open={suiteOpen} />
                          <Ico v={su.icon} size={22} />
                          <span style={ellip}>{su.name}</span>
                        </button>
                        {su.liveDashboardId && <LiveBtn onClick={() => go(su.id, su.liveDashboardId)} title={`Live ticket sales — ${su.name}`} />}
                      </div>
                    )}
                    {single && su.liveDashboardId && (
                      <div style={{ padding: '0 12px 6px' }}><LiveBtn wide onClick={() => go(su.id, su.liveDashboardId)} title={`Live ticket sales — ${su.name}`} /></div>
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
                  {!opsOnly && fl('goals') && (visibleSuites.length > 0 || isAdmin) && (
                  <button
                    className={`nav-row${onGoals ? ' active' : ''}`}
                    style={{ ...mRowSuite, fontWeight: onGoals ? 700 : 500 }}
                    onClick={() => { if (!onGoals) vtNavigate(navigate, '/goals'); setNavOpen(false); }}
                  >
                    <span style={{ fontSize: 17, lineHeight: 1, flexShrink: 0 }}>🎯</span>
                    <span style={ellip}>Goals</span>
                  </button>
                  )}
                  {!opsOnly && fl('alerts') && (visibleSuites.length > 0 || isAdmin) && (
                  <button
                    className={`nav-row${onAlerts ? ' active' : ''}`}
                    style={{ ...mRowSuite, fontWeight: onAlerts ? 700 : 500 }}
                    onClick={() => { if (!onAlerts) vtNavigate(navigate, '/alerts'); setNavOpen(false); }}
                  >
                    <span style={{ fontSize: 17, lineHeight: 1, flexShrink: 0 }}>🔔</span>
                    <span style={ellip}>Alerts</span>
                  </button>
                  )}
                  {eventopsOn && (
                  <button
                    className={`nav-row${onEventOps ? ' active' : ''}`}
                    style={{ ...mRowSuite, fontWeight: onEventOps ? 700 : 500 }}
                    onClick={() => { if (!onEventOps) vtNavigate(navigate, '/event-ops'); setNavOpen(false); }}
                  >
                    <span style={{ fontSize: 17, lineHeight: 1, flexShrink: 0 }}>📟</span>
                    <span style={ellip}>Event Ops</span>
                  </button>
                  )}
                  {!opsOnly && fl('digests') && can(PERMS.DIGESTS_MANAGE) && (
                  <button
                    className={`nav-row${onDigests ? ' active' : ''}`}
                    style={{ ...mRowSuite, fontWeight: onDigests ? 700 : 500 }}
                    onClick={() => { if (!onDigests) vtNavigate(navigate, '/digests'); setNavOpen(false); }}
                  >
                    <span style={{ fontSize: 17, lineHeight: 1, flexShrink: 0 }}>🗓</span>
                    <span style={ellip}>Digests</span>
                  </button>
                  )}
                  {!opsOnly && fl('settlements') && can(PERMS.SETTLEMENTS_VIEW) && (visibleSettlements.length > 0 || isAdmin) && (
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
                  {!opsOnly && inbox.enabled && (
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
                  {!opsOnly && (
                  <button
                    className={`nav-row${onJourney ? ' active' : ''}`}
                    style={{ ...mRowSuite, fontWeight: onJourney ? 700 : 500 }}
                    onClick={() => { if (!onJourney) vtNavigate(navigate, '/journey'); setNavOpen(false); }}
                  >
                    <span style={{ fontSize: 17, lineHeight: 1, flexShrink: 0 }}>⚡</span>
                    <span style={ellip}>Your journey</span>
                  </button>
                  )}
                  {fl('report') && (<>
                  <button
                    className={`nav-row${onProduct ? ' active' : ''}`}
                    style={{ ...mRowSuite, fontWeight: onProduct ? 700 : 500 }}
                    onClick={() => { if (!onProduct) vtNavigate(navigate, '/product'); setNavOpen(false); }}
                  >
                    <span style={{ fontSize: 17, lineHeight: 1, flexShrink: 0 }}>🎟️</span>
                    <span style={ellip}>Product</span>
                  </button>
                  <button
                    className="nav-row"
                    style={{ ...mRowSuite, fontWeight: 500 }}
                    onClick={() => { openReport(); setNavOpen(false); }}
                  >
                    <span style={{ fontSize: 17, lineHeight: 1, flexShrink: 0 }}>💬</span>
                    <span style={ellip}>Report an issue</span>
                  </button>
                  </>)}
                  {fl('engage') && can(PERMS.CAMPAIGNS_VIEW) && (
                  <>
                  <div style={{ padding: '8px 8px 6px 14px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>Engage</div>
                  {fl('engage.campaigns') && (
                  <button
                    className={`nav-row${onActions ? ' active' : ''}`}
                    style={{ ...mRowSuite, fontWeight: onActions ? 700 : 500 }}
                    onClick={() => { if (!onActions) vtNavigate(navigate, '/engage/campaigns'); setNavOpen(false); }}
                  >
                    <span style={{ fontSize: 17, lineHeight: 1, flexShrink: 0 }}>📣</span>
                    <span style={ellip}>Campaigns</span>
                  </button>
                  )}
                  {fl('engage.segments') && (
                  <button
                    className={`nav-row${onSegments ? ' active' : ''}`}
                    style={{ ...mRowSuite, fontWeight: onSegments ? 700 : 500 }}
                    onClick={() => { if (!onSegments) vtNavigate(navigate, '/engage/segments'); setNavOpen(false); }}
                  >
                    <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>🥧</span>
                    <span style={ellip}>Segments</span>
                  </button>
                  )}
                  </>
                  )}
                </>
              )}
            </div>
            <ProfileFooter
              user={user}
              isAdmin={isAdmin}
              activeEntityId={activeEntityId}
              brand={brand}
              onNavigate={(path) => { navigate(path); setNavOpen(false); }}
            />
          </div>
        </div>
      )}
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
        {/* Platform status notices — active incidents (and recently-resolved ones)
            affecting this client. Self-contained: polls /api/my/notices. */}
        <StatusNoticeBanner />
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
        {/* Approval banner — campaigns awaiting THIS user's sign-off. Persistent
            until cleared; taps through to the campaign. */}
        {!location.pathname.startsWith('/actions') && (inbox.awaitingMyApproval?.count > 0) && (
          <button
            onClick={() => vtNavigate(navigate, inbox.awaitingMyApproval.first ? `/actions?action=${inbox.awaitingMyApproval.first}` : '/actions')}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', border: 'none', cursor: 'pointer', textAlign: 'left', padding: '10px 16px', background: 'linear-gradient(90deg, #f59e0b, #ea580c)', color: '#fff', fontSize: 13 }}
          >
            <span style={{ fontSize: 15 }}>⏳</span>
            <span style={{ fontWeight: 700 }}>{inbox.awaitingMyApproval.count === 1 ? 'A campaign is waiting for your approval' : `${inbox.awaitingMyApproval.count} campaigns are waiting for your approval`}</span>
            <span style={{ flex: 1 }} />
            <span style={{ background: 'rgba(255,255,255,0.25)', borderRadius: 980, padding: '5px 14px', fontWeight: 700, flexShrink: 0 }}>Review →</span>
          </button>
        )}
        {/* Approval-outcome banner — ALWAYS shown to the campaign's creator when a
            request is approved or sent back, until they acknowledge it. */}
        {(inbox.myOutcomes || []).map((o) => {
          const approved = o.outcome === 'approved';
          const ack = () => { api.ackCampaignOutcome(activeEntityId, o.id).catch(() => {}); setInbox((s) => ({ ...s, myOutcomes: (s.myOutcomes || []).filter((x) => x.id !== o.id) })); };
          return (
            <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 16px', color: '#fff', fontSize: 13, background: approved ? 'linear-gradient(90deg, #16a34a, #15803d)' : 'linear-gradient(90deg, #f59e0b, #dc2626)' }}>
              <span style={{ fontSize: 15 }}>{approved ? '✅' : '↩️'}</span>
              <button onClick={() => { ack(); vtNavigate(navigate, `/actions?action=${o.id}`); }} style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', color: '#fff', cursor: 'pointer', padding: 0, fontSize: 13 }}>
                <span style={{ fontWeight: 700 }}>“{o.title}” was {approved ? 'approved' : 'sent back to draft'}{o.by ? ` by ${o.by}` : ''}{approved ? ' — now sending' : ''}.</span>
                {!approved && o.note ? <span style={{ opacity: 0.9 }}> {o.note}</span> : null}
              </button>
              <span onClick={() => { ack(); vtNavigate(navigate, `/actions?action=${o.id}`); }} style={{ background: 'rgba(255,255,255,0.25)', borderRadius: 980, padding: '5px 14px', fontWeight: 700, flexShrink: 0, cursor: 'pointer' }}>Open →</span>
              <button onClick={ack} title="Dismiss" style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 17, lineHeight: 1, flexShrink: 0, opacity: 0.85 }}>×</button>
            </div>
          );
        })}
        {/* Admin previewing/acting-as a client — show on EVERY device (the
            "Preview" buttons put you in client mode, which previewMode alone
            misses) with a one-tap exit back to the console. Compact on mobile so
            the Exit button always fits. */}
        {/* 👁 View-as banner: an admin is inside a client USER's session (hint
            cookie set by the server; the session itself carries the authority). */}
        {(() => {
          const m = document.cookie.match(/(?:^|;\s*)howler_viewing_as=([^;]+)/);
          if (!m) return null;
          return (
            <div style={{ ...previewBar, background: 'linear-gradient(90deg, #7C3AED, #A855F7)' }}>
              <span style={{ fontWeight: 700 }}>👁 Viewing as {decodeURIComponent(m[1])}</span>
              {!isMobile && <span style={{ opacity: 0.85 }}>You see exactly what they see — their role, dashboards and features.</span>}
              <div style={{ flex: 1 }} />
              <button style={exitPreviewBtn} onClick={() => api.impersonateExit().then(() => { window.location.href = '/admin'; }).catch(() => { window.location.href = '/login'; })}>Exit</button>
            </div>
          );
        })()}
        {isAdmin && !!activeEntityId && (
          <div style={previewBar}>
            <span style={{ fontWeight: 700 }}>👁 Client preview{(() => { const n = suites.find((s) => s.entityId === activeEntityId)?.entityName || active?.name; return n ? ` — ${n}` : ''; })()}</span>
            {!isMobile && <span style={{ opacity: 0.85 }}>You're viewing this exactly as the client would, scoped to their data.</span>}
            <div style={{ flex: 1 }} />
            <button style={exitPreviewBtn} onClick={() => { enterConsole(); navigate('/admin'); }}>Exit preview</button>
          </div>
        )}
        {(isMobile || collapsed) && (
          <div style={menuBar}>
            <button style={menuBtn} onClick={() => (isMobile ? setNavOpen(true) : toggleCollapsed())} title="Menu" aria-label="Open menu">☰</button>
            {/* No back button — Home (and the phone's own back gesture) cover it, and the
                extra arrow just crowded the bar. */}
            <button style={menuBtn} onClick={() => vtNavigate(navigate, previewMode ? '/preview' : '/')} title="Home" aria-label="Home">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 10.5 12 3l9 7.5" />
                <path d="M5 9.5V21h5.5v-6h3v6H19V9.5" />
              </svg>
            </button>
            {/* Dashboard pages show their live tile title; section pages (Alerts,
                Goals, Event Ops…) portal their page title in here via <PageHeader>
                so there's no second home button and no tall header below. */}
            {activeTitle
              ? <span style={{ flex: 1, fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeTitle}</span>
              : <span ref={setTitleSlot} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center' }} />}
            {/* Page (dashboard) actions portal in here — Summary · Filters · ⋯ */}
            <div ref={setActionsSlot} style={{ display: 'flex', alignItems: 'center', gap: 7, marginLeft: 'auto', flexShrink: 0 }} />
          </div>
        )}
        <Outlet context={{ previewEntityId: activeEntityId, actionsSlot, titleSlot }} />
      </main>
      {(FEATURES.ask || owlNativeChatEnabled(user)) && !askOpen && (
        // Floating owl — quick launcher for the analyst drawer (bottom-right).
        // Hover/focus pre-warms the analyst so the first open is instant.
        <button
          onClick={() => openAsk()}
          onMouseEnter={() => setPrewarmAsk(true)}
          onFocus={() => setPrewarmAsk(true)}
          title="Ask your AI analyst"
          aria-label="Ask your AI analyst"
          style={{ position: 'fixed', bottom: 20, right: isMobile ? 16 : 24, zIndex: 55, width: 54, height: 54, borderRadius: '50%', border: '1px solid var(--hairline)', background: 'var(--card)', boxShadow: '0 6px 22px rgba(0,0,0,0.3)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <AiMark size={28} sparkle={false} />
        </button>
      )}
      {owlNativeChatEnabled(user)
        ? <OwlChat open={askOpen} onClose={() => setAskOpen(false)} suiteId={suiteId} entityId={activeEntityId} dashboardId={id} clients={owlClients} events={owlEvents} isAdmin={isAdmin} seed={owlSeed} onSeedUsed={() => setOwlSeed(null)} />
        : <AnalystDrawer open={askOpen} prewarm={prewarmAsk} onClose={() => setAskOpen(false)} previewEntityId={activeEntityId} />}
    </div>
  );
}

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
}

// Bottom-left profile: avatar + identity, opening a menu with Integrations
// (clients), the theme toggle and Log out — everything that used to crowd the
// top header.
function ProfileFooter({ user, isAdmin, activeEntityId, brand, onNavigate }) {
  const { theme, toggle } = useTheme();
  const { logout } = useAuth();
  const brandLogoUrl = useBrandLogo(theme); // the active client's resolved branding logo (dark-mode variant when set)
  const [open, setOpen] = useState(false);
  const entity = user?.entities?.[0];
  const name = isAdmin ? 'Howler · Admin' : (brand?.entityName || entity?.name || (user?.email || '').split('@')[0]);
  // The footer identifies the LOGIN, not the active client (the top-left switcher
  // shows the client). For an admin that's "Howler · Admin" — never a client's
  // logo. Without this gate the logo falls back to user.entities[0].logo (the
  // admin's FIRST linked client, e.g. Kappa), which bleeds the wrong brand in
  // next to "Howler · Admin".
  // Prefer the client's resolved BRANDING logo (what they set under Branding,
  // falling back to their entity logo) so a branding change shows here live.
  const logo = isAdmin ? '' : (brandLogoUrl || brand?.entityLogo || entity?.logo || '');
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  return (
    <div style={{ position: 'relative', borderTop: '1px solid var(--hairline)', padding: 8, flexShrink: 0 }}>
      {open && <div style={{ position: 'fixed', inset: 0, zIndex: 70 }} onClick={() => setOpen(false)} />}
      {open && (
        <div className="modal-in" style={profileMenu}>
          {/* Settings is a client self-service page scoped to the active entity.
              Show it whenever a client profile is in context — for pure clients
              always, and for an admin acting as / previewing a client (so an
              admin who's also an owner of the account can manage it). Admins in
              the bare console (no client in context) don't see it — they use the
              Admin console. */}
          {activeEntityId && (
            <>
              <button className="nav-row" style={menuItem} onClick={() => { setOpen(false); onNavigate('/settings'); }}>
                <span style={menuIco}>⚙</span> Settings
              </button>
              <div style={menuDivider} />
            </>
          )}
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
      <VersionStamp />
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
// One-tap jump to the suite's designated "live" (ticket-sales) dashboard — a
// small red pill on the event's row so no drill-down is needed. `wide` fills the
// row on single-suite mobile (where the suite header itself is hidden).
function LiveBtn({ onClick, title, wide }) {
  return (
    <button onClick={onClick} title={title} aria-label={title} style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, flexShrink: 0,
      width: wide ? '100%' : undefined, cursor: 'pointer',
      background: 'transparent', color: 'var(--success)', border: '1.5px solid var(--success)', borderRadius: 980,
      padding: '3px 10px', fontSize: 10.5, fontWeight: 800, letterSpacing: '0.04em',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', '--live-ring': 'color-mix(in srgb, var(--success) 55%, transparent)', animation: 'howlerPulse 1.6s ease-out infinite' }} />
      LIVE
    </button>
  );
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
const menuBtn = { flexShrink: 0, width: 42, height: 42, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 980, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 20, lineHeight: 1, cursor: 'pointer' };
const previewBar = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 16px', background: 'linear-gradient(90deg, var(--brand), var(--brand-2))', color: '#fff', fontSize: 13 };
const exitPreviewBtn = { flexShrink: 0, padding: '6px 14px', borderRadius: 980, border: 'none', background: 'rgba(255,255,255,0.25)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' };
const iconBtn = { width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--hairline)', borderRadius: 7, background: 'var(--card)', color: 'var(--muted-2)', fontSize: 12, cursor: 'pointer' };
