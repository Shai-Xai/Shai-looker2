import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Link, Navigate, useNavigate, useLocation } from 'react-router-dom';
import HomePage from './pages/HomePage.jsx';
import ViewPage from './pages/ViewPage.jsx';
import InboxNotifier from './components/InboxNotifier.jsx';
import UpdateBanner from './components/UpdateBanner.jsx';
import ReportWidget from './components/ReportWidget.jsx';
import LivePulse from './components/LivePulse.jsx';
import LoginPage from './pages/LoginPage.jsx';
import ResetPasswordPage from './pages/ResetPasswordPage.jsx';
import MagicLinkPage from './pages/MagicLinkPage.jsx';
import ClientLayout from './pages/ClientLayout.jsx';
import ClientHome from './pages/ClientHome.jsx';
import ClientIntegrationsPage from './pages/ClientIntegrationsPage.jsx';
import SettlementsPage from './pages/SettlementsPage.jsx';
import InboxPage from './os/InboxPage.jsx';
import GoalsPage from './pages/GoalsPage.jsx';
import AlertsPage from './pages/AlertsPage.jsx';
import MyReportsPage from './pages/MyReportsPage.jsx';
import JourneyPage from './pages/JourneyPage.jsx';
// Code-split the heavy / admin-only / secondary screens out of the initial
// bundle — they load on first navigation (and clients never download the admin +
// editor surfaces at all). The common client path stays eager for instant paint.
const AdminPage = lazy(() => import('./pages/AdminPage.jsx'));
const SplitPage = lazy(() => import('./pages/SplitPage.jsx'));
const EditorPage = lazy(() => import('./pages/EditorPage.jsx'));
const ClonePage = lazy(() => import('./pages/ClonePage.jsx'));
const EngagePage = lazy(() => import('./pages/EngagePage.jsx'));
const EngageAppPage = lazy(() => import('./pages/EngageAppPage.jsx'));
const SettlementViewPage = lazy(() => import('./pages/SettlementViewPage.jsx'));
const DocumentViewPage = lazy(() => import('./pages/DocumentViewPage.jsx'));
const DigestsPage = lazy(() => import('./pages/DigestsPage.jsx'));
const SocialPage = lazy(() => import('./pages/SocialPage.jsx'));
const AppAnalyticsPage = lazy(() => import('./pages/AppAnalyticsPage.jsx'));
const InventiveAskPage = lazy(() => import('./pages/InventiveAskPage.jsx'));
const OwlEmbedPage = lazy(() => import('./pages/OwlEmbedPage.jsx'));
const FanOwlEmbedPage = lazy(() => import('./pages/FanOwlEmbedPage.jsx'));
const EventOpsPage = lazy(() => import('./pages/EventOpsPage.jsx'));
const MapStudioPage = lazy(() => import('./pages/MapStudioPage.jsx'));
const EventMediaPage = lazy(() => import('./pages/EventMediaPage.jsx'));
const EventOpsPortalPage = lazy(() => import('./pages/EventOpsPortalPage.jsx'));
const EventOpsCallPage = lazy(() => import('./pages/EventOpsCallPage.jsx'));
const ReportsPage = lazy(() => import('./pages/ReportsPage.jsx'));
const ReportViewPage = lazy(() => import('./pages/ReportViewPage.jsx'));
import Logo from './components/Logo.jsx';
import BrandLogo from './components/BrandLogo.jsx';
import { api } from './lib/api.js';
import { isStandalone } from './lib/pwa.js';
import RootErrorBoundary from './components/RootErrorBoundary.jsx';
import { DrillProvider } from './lib/DrillContext.jsx';
import { AuthProvider, useAuth } from './lib/auth.jsx';
import { ProfileProvider, useProfile } from './lib/profile.jsx';
import { ThemeProvider, useTheme } from './lib/theme.jsx';
import { useIsMobile } from './lib/useIsMobile.js';

// Shown while a lazy-loaded route chunk is fetched. An empty flex filler keeps the
// layout stable (no spinner flash) — split chunks resolve in a few ms once cached.
function ScreenFallback() { return <div style={{ flex: 1 }} aria-busy="true" />; }

// Legacy /actions and /segments now live as tabs under the Engage hub. Redirect
// while preserving the query string so deep links (?action=, ?goal=) survive.
function RedirectTo({ to }) {
  const location = useLocation();
  return <Navigate to={{ pathname: to, search: location.search }} replace />;
}

function Header() {
  const navigate = useNavigate();
  const { user, isAdmin, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const { active, entities, activeEntityId, mode, setProfile, enterConsole } = useProfile();
  const isMobile = useIsMobile();
  // "In a client experience" = a client login, or an admin acting as one of
  // their client accounts. Then the header leads with the client's identity and
  // the Howler·Pulse badge sits on the right as the "powered by". In the admin
  // console it's the reverse: Howler brand left, admin controls right.
  const inClientView = mode === 'client' && !!active;
  // The top-left identity doubles as the workspace switcher when there's
  // somewhere else to go: a client with >1 profile, or ANY admin that's linked
  // to client accounts (so they can flip between console and those clients).
  // Admins always need the switcher while in a client experience (incl. previewing
  // a client they aren't linked to) so they can get back to the console.
  const canSwitch = isAdmin ? (entities.length > 0 || inClientView) : entities.length > 1;
  const enterClient = (id) => { setProfile(id); navigate('/'); };
  const goConsole = () => { enterConsole(); navigate('/admin'); };
  const location = useLocation();
  // "Home" for an admin: the dashboard home when you're in a dashboard view
  // (incl. the editor), otherwise the admin console. Clients always go to '/'.
  const inDashboards = /^\/(dashboards|d\/|clone)/.test(location.pathname);
  const goHome = () => navigate(isAdmin && !inClientView ? (inDashboards ? '/dashboards' : '/admin') : '/');
  return (
    <header className="app-chrome" style={{
      borderBottom: '1px solid var(--hairline)', padding: isMobile ? '0 14px' : '0 22px',
      // position+zIndex so the header's stacking context (its backdrop-filter
      // creates one) sits ABOVE the client menu bar (z20) — otherwise the
      // workspace dropdown's top items (Admin console) hide behind that bar.
      height: 56, display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 12, flexShrink: 0, position: 'relative', zIndex: 30,
    }}>
      <WorkspaceSwitcher
        inClientView={inClientView}
        active={active}
        entities={entities}
        activeEntityId={activeEntityId}
        isAdmin={isAdmin}
        canSwitch={canSwitch}
        onEnterClient={enterClient}
        onConsole={goConsole}
        onHome={goHome}
      />
      <LivePulse entityId={inClientView ? activeEntityId : null} />
      {/* Admin console: admin controls on the right. Client experience (client
          login OR admin acting as a client): just the Howler·Pulse badge — the
          account actions live in the sidebar's bottom-left profile menu. */}
      {isAdmin && !inClientView ? (
        // On the desktop Admin console these controls live in the left rail's
        // bottom profile menu, so drop them from the top bar there (keep Split —
        // it has no rail equivalent). Elsewhere (Dashboards, editor) and on
        // mobile, keep them in the top bar.
        (!isMobile && location.pathname === '/admin') ? (
          window.self === window.top && <button onClick={() => navigate('/split')} title="Admin + client portal side by side" style={navLink}>⿲ Split view</button>
        ) : (
        <>
          {!isMobile && window.self === window.top && <button onClick={() => navigate('/split')} title="Admin + client portal side by side" style={navLink}>⿲ Split</button>}
          <Link to="/admin" style={navLink}>Admin</Link>
          <button onClick={toggle} title={theme === 'dark' ? 'Light mode' : 'Dark mode'} aria-label="Toggle theme" style={themeBtn}>{theme === 'dark' ? '☀️' : '🌙'}</button>
          {!isMobile && <UserBadge user={user} isAdmin={isAdmin} />}
          <button onClick={() => logout()} style={logoutBtn}>{isMobile ? 'Exit' : 'Log out'}</button>
        </>
        )
      ) : inClientView && (
        <>
          {/* Admin in a client experience: one-click back doors to the backend —
              no profile switching. Hidden inside split panes (window.top check)
              where they'd nest views. */}
          {isAdmin && window.self === window.top && (
            <>
              <button onClick={goConsole} title="Open the Howler admin console" style={navLink}>🛠 {isMobile ? '' : 'Howler Admin'}</button>
              {!isMobile && <button onClick={() => { enterConsole(); navigate('/split'); }} title="Admin + client portal side by side" style={navLink}>⿲ Split</button>}
            </>
          )}
          <button onClick={() => navigate('/')} title="Powered by Howler Pulse" style={{ display: 'flex', alignItems: 'center', gap: 7, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, opacity: 0.85 }}>
            <Logo size={22} radius={6} />
            {!isMobile && <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.2px', color: 'var(--muted)' }}>Howler&nbsp;:&nbsp;Pulse</span>}
          </button>
        </>
      )}
    </header>
  );
}

// Top-left identity + workspace switcher. Shows the active client's identity (in
// a client experience) or the Howler·Pulse brand (admin console). When the login
// can go elsewhere, clicking it drops a list: for admins, "Admin console" plus
// each linked client; for clients, their profiles.
function WorkspaceSwitcher({ inClientView, active, entities, activeEntityId, isAdmin, canSwitch, onEnterClient, onConsole, onHome }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const Avatar = ({ e, size }) => (
    e.logo
      ? <img src={e.logo} alt="" style={{ height: size, maxWidth: size * 2.8, objectFit: 'contain', flexShrink: 0 }} />
      : <span style={{ width: size, height: size, borderRadius: 7, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.5, fontWeight: 800, color: '#fff', background: 'var(--brand)' }}>{(e.name || '?').trim().charAt(0).toUpperCase()}</span>
  );
  const idRow = inClientView ? (
    <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <BrandLogo size={30} name={active?.name} fallback={active?.logo} />
      <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.2px', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{active.name}</span>
    </span>
  ) : (
    <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <Logo size={30} radius={8} />
      <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.3px', color: 'var(--text)' }}>Howler&nbsp;:&nbsp;Pulse</span>
    </span>
  );
  if (!canSwitch) {
    return <button onClick={onHome} style={identityBtn} title="Home">{idRow}</button>;
  }
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} style={identityBtn} title="Switch workspace">
        {idRow}
        <span style={{ flexShrink: 0, fontSize: 14, color: 'var(--text)', lineHeight: 1, marginLeft: 3, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
      </button>
      {open && (
        <div className="modal-in" style={identityMenu}>
          {isAdmin && (
            <>
              <div style={menuCap}>Howler</div>
              <button className="nav-row" onClick={() => { setOpen(false); if (inClientView) onConsole(); }}
                style={{ ...identityItem, background: !inClientView ? 'rgba(128,128,128,0.10)' : 'transparent' }}>
                <span style={{ width: 22, textAlign: 'center', fontSize: 15, flexShrink: 0 }}>⚙</span>
                <span style={{ flex: 1, textAlign: 'left', fontWeight: !inClientView ? 700 : 500, fontSize: 14 }}>Admin console</span>
                {!inClientView && <span style={{ flexShrink: 0, color: 'var(--brand)', fontWeight: 700 }}>✓</span>}
              </button>
              {entities.length > 0 && <div style={menuCap}>Act as client</div>}
            </>
          )}
          {entities.map((e) => {
            const on = inClientView && e.id === activeEntityId;
            return (
              <button key={e.id} className="nav-row" onClick={() => { setOpen(false); if (!on) onEnterClient(e.id); }}
                style={{ ...identityItem, background: on ? 'rgba(128,128,128,0.10)' : 'transparent' }}>
                <Avatar e={e} size={22} />
                <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: on ? 700 : 500, fontSize: 14 }}>{e.name}</span>
                {on && <span style={{ flexShrink: 0, color: 'var(--brand)', fontWeight: 700 }}>✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Top-right identity: the client's logo + name (for client logins) and the
// signed-in email. Admins just show their email + an "admin" tag.
function UserBadge({ user, isAdmin }) {
  const client = !isAdmin ? (user?.entities || [])[0] : null;
  const extra = !isAdmin && (user?.entities || []).length > 1 ? ` +${user.entities.length - 1}` : '';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2, alignItems: 'flex-end' }}>
        {client ? (
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{client.name}{extra}</span>
        ) : (
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Howler{isAdmin ? ' · Admin' : ''}</span>
        )}
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{user?.email}</span>
      </div>
    </div>
  );
}

const identityBtn = { display: 'flex', alignItems: 'center', gap: 8, border: 'none', background: 'transparent', cursor: 'pointer', padding: '4px 8px 4px 4px', borderRadius: 10, minWidth: 0 };
const identityMenu = { position: 'absolute', top: 'calc(100% + 6px)', left: 0, minWidth: 220, zIndex: 71, background: 'var(--glass-bg)', backdropFilter: 'blur(var(--glass-blur)) saturate(180%)', WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(180%)', border: '1px solid var(--glass-border)', borderRadius: 14, boxShadow: 'var(--glass-shadow), inset 0 1px 0 var(--glass-hi)', padding: 6, display: 'flex', flexDirection: 'column', gap: 2 };
const identityItem = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', border: 'none', cursor: 'pointer', padding: '8px 10px', borderRadius: 9, color: 'var(--text)' };
const menuCap = { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', padding: '6px 10px 4px' };
const navLink = { fontSize: 13, fontWeight: 600, color: 'var(--brand)', textDecoration: 'none' };
const logoutBtn = { fontSize: 12, fontWeight: 600, border: 'none', background: 'rgba(128,128,128,0.12)', color: 'var(--text)', borderRadius: 980, padding: '7px 14px', cursor: 'pointer' };
const themeBtn = { border: 'none', background: 'rgba(128,128,128,0.12)', borderRadius: 980, width: 30, height: 30, fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 };

function Shell() {
  const { user, loading, isAdmin } = useAuth();
  const { mode, activeEntityId } = useProfile();

  // Tell the server when this user is running Pulse as an installed app (home
  // screen / standalone) — stamps their install + last-opened so admin can see it.
  useEffect(() => { if (user && isStandalone()) api.markInstalled(); }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // PUBLIC staff scan portal — token-gated, no Pulse login (works logged-in or out).
  // Matched before the auth gate so staff with no account reach it directly.
  const portal = window.location.pathname.match(/^\/eventops\/portal\/([^/]+)\/([^/]+)/);
  if (portal) {
    return (
      <Suspense fallback={<div style={{ minHeight: '100dvh' }} />}>
        <EventOpsPortalPage suiteId={decodeURIComponent(portal[1])} token={decodeURIComponent(portal[2])} />
      </Suspense>
    );
  }
  // PUBLIC device support-call page — pre-bound to one station + device (both in the
  // URL). No login; works logged-in or out, and from any phone. Matched before the gate.
  const callLink = window.location.pathname.match(/^\/eventops\/call\/([^/]+)\/([^/]+)\/([^/]+)/);
  if (callLink) {
    return (
      <Suspense fallback={<div style={{ minHeight: '100dvh' }} />}>
        <EventOpsCallPage suiteId={decodeURIComponent(callLink[1])} token={decodeURIComponent(callLink[2])} deviceId={decodeURIComponent(callLink[3])} />
      </Suspense>
    );
  }

  if (loading) {
    return <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>Loading…</div>;
  }
  // Logged out: the recovery/passwordless landing pages live OUTSIDE the router
  // (which only mounts once authenticated), so dispatch on the path here.
  if (!user) {
    const path = window.location.pathname;
    if (path === '/reset') return <ResetPasswordPage />;
    if (path === '/magic') return <MagicLinkPage />;
    // A bare /<slug> is treated as a client's vanity login — LoginPage paints
    // their brand if the slug resolves, else falls back to the standard login.
    const slug = path.replace(/^\/+/, '').split('/')[0];
    return <LoginPage slug={slug} />;
  }

  // An admin who has switched into one of their client accounts gets the real
  // client shell (scoped to that entity), not the admin console.
  const actingAsClient = isAdmin && mode === 'client' && !!activeEntityId;

  return (
    <BrowserRouter>
      <DrillProvider>
        <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
          <Header />
          <UpdateBanner />
          <InboxNotifier entityId={mode === 'client' ? activeEntityId : undefined} />
          <ReportWidget />
          <Suspense fallback={<ScreenFallback />}>
          {isAdmin && !actingAsClient ? (
            <Routes>
              <Route path="/" element={<Navigate to="/admin" replace />} />
              <Route path="/dashboards" element={<HomePage />} />
              <Route path="/d/:id" element={<ViewPage />} />
              <Route path="/d/:id/edit" element={<EditorPage />} />
              {/* Editing a dashboard opened inside a suite keeps the suite in the
                  URL so the editor's Back/View return to the suite view. */}
              <Route path="/suite/:suiteId/d/:id/edit" element={<EditorPage />} />
              <Route path="/clone" element={<ClonePage />} />
              <Route path="/admin" element={<AdminPage />} />
              {/* Admin + client portal side by side (desktop). */}
              <Route path="/split" element={<SplitPage />} />
              {/* Preview the client experience without logging in as them. */}
              <Route element={<ClientLayout />}>
                <Route path="/preview" element={<ClientHome />} />
                <Route path="/suite/:suiteId/d/:id" element={<ViewPage />} />
                <Route path="/goals" element={<GoalsPage />} />
                <Route path="/alerts" element={<AlertsPage />} />
                <Route path="/social" element={<SocialPage />} />
                <Route path="/app-analytics" element={<AppAnalyticsPage />} />
                <Route path="/settlements" element={<SettlementsPage />} />
                <Route path="/settlements/:id" element={<SettlementViewPage />} />
                <Route path="/documents/:id" element={<DocumentViewPage />} />
                <Route path="/inbox" element={<InboxPage />} />
                <Route path="/digests" element={<DigestsPage />} />
                <Route path="/reports" element={<ReportsPage />} />
                <Route path="/product" element={<MyReportsPage />} />
                <Route path="/journey" element={<JourneyPage />} />
                <Route path="/engage" element={<EngagePage />} />
                <Route path="/ask" element={<InventiveAskPage />} />
                <Route path="/event-ops" element={<EventOpsPage />} />
                <Route path="/engage/app" element={<EngageAppPage />} />
                <Route path="/engage/app/:tab" element={<EngageAppPage />} />
                {/* Community moved out of the Engage tab row into Engage → App. */}
                <Route path="/engage/community" element={<RedirectTo to="/engage/app/posts" />} />
                <Route path="/event-map" element={<MapStudioPage />} />
                <Route path="/event-media" element={<EventMediaPage />} />
                <Route path="/engage/:tab" element={<EngagePage />} />
                <Route path="/actions" element={<RedirectTo to="/engage/campaigns" />} />
                <Route path="/segments" element={<RedirectTo to="/engage/segments" />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          ) : (
            // Clients get a persistent Suites → Sets → Dashboards sidebar.
            <Routes>
              <Route element={<ClientLayout />}>
                <Route path="/" element={<ClientHome />} />
                <Route path="/settings" element={<ClientIntegrationsPage />} />
                <Route path="/suite/:suiteId/d/:id" element={<ViewPage />} />
                {/* Editor is admin-only (guarded inside EditorPage) but mounted
                    here too so an admin acting as a client can edit without the
                    route falling through to "home". */}
                <Route path="/d/:id/edit" element={<EditorPage />} />
                <Route path="/suite/:suiteId/d/:id/edit" element={<EditorPage />} />
                <Route path="/goals" element={<GoalsPage />} />
                <Route path="/alerts" element={<AlertsPage />} />
                <Route path="/social" element={<SocialPage />} />
                <Route path="/app-analytics" element={<AppAnalyticsPage />} />
                <Route path="/settlements" element={<SettlementsPage />} />
                <Route path="/settlements/:id" element={<SettlementViewPage />} />
                <Route path="/documents/:id" element={<DocumentViewPage />} />
                <Route path="/inbox" element={<InboxPage />} />
                <Route path="/digests" element={<DigestsPage />} />
                <Route path="/reports" element={<ReportsPage />} />
                <Route path="/product" element={<MyReportsPage />} />
                <Route path="/journey" element={<JourneyPage />} />
                <Route path="/engage" element={<EngagePage />} />
                <Route path="/ask" element={<InventiveAskPage />} />
                <Route path="/event-ops" element={<EventOpsPage />} />
                <Route path="/engage/app" element={<EngageAppPage />} />
                <Route path="/engage/app/:tab" element={<EngageAppPage />} />
                {/* Community moved out of the Engage tab row into Engage → App. */}
                <Route path="/engage/community" element={<RedirectTo to="/engage/app/posts" />} />
                <Route path="/event-map" element={<MapStudioPage />} />
                <Route path="/event-media" element={<EventMediaPage />} />
                <Route path="/engage/:tab" element={<EngagePage />} />
                <Route path="/actions" element={<RedirectTo to="/engage/campaigns" />} />
                <Route path="/segments" element={<RedirectTo to="/engage/segments" />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          )}
          </Suspense>
        </div>
      </DrillProvider>
    </BrowserRouter>
  );
}

export default function App() {
  // The organizer-portal Owl (docs/OWL_EMBED.md): a chromeless page with its own
  // token auth. It mounts OUTSIDE AuthProvider/router — there's no cookie session
  // in a cross-site iframe, and those would bounce the visitor to the login screen.
  // The fan-facing Owl widget (docs/specs/FAN_OWL_SPEC.md): a public, auth-less
  // chat iframed on promoters' event sites. No providers at all — no session, no
  // profile; the URL-fragment session id is its only credential.
  if (window.location.pathname === '/embed/fan') {
    return (
      <RootErrorBoundary>
        <Suspense fallback={<ScreenFallback />}>
          <FanOwlEmbedPage />
        </Suspense>
      </RootErrorBoundary>
    );
  }
  // PUBLIC report viewer (/r/:token) — Report Studio share links open for
  // stakeholders with no Pulse login, so it mounts OUTSIDE AuthProvider/router.
  // The token is the capability; the page fetches the frozen snapshot only.
  const reportShare = window.location.pathname.match(/^\/r\/([^/]+)$/);
  if (reportShare) {
    return (
      <RootErrorBoundary>
        <Suspense fallback={<div style={{ minHeight: '100dvh' }} />}>
          <ReportViewPage token={decodeURIComponent(reportShare[1])} />
        </Suspense>
      </RootErrorBoundary>
    );
  }
  if (window.location.pathname === '/embed/owl') {
    return (
      <RootErrorBoundary>
        <ThemeProvider>
          <Suspense fallback={<ScreenFallback />}>
            <OwlEmbedPage />
          </Suspense>
        </ThemeProvider>
      </RootErrorBoundary>
    );
  }
  return (
    <RootErrorBoundary>
      <ThemeProvider>
        <AuthProvider>
          <ProfileProvider>
            <Shell />
          </ProfileProvider>
        </AuthProvider>
      </ThemeProvider>
    </RootErrorBoundary>
  );
}
