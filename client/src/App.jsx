import { useState, useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, Link, Navigate, useNavigate, useLocation } from 'react-router-dom';
import HomePage from './pages/HomePage.jsx';
import ViewPage from './pages/ViewPage.jsx';
import EditorPage from './pages/EditorPage.jsx';
import ClonePage from './pages/ClonePage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import InboxNotifier from './components/InboxNotifier.jsx';
import LoginPage from './pages/LoginPage.jsx';
import ClientLayout from './pages/ClientLayout.jsx';
import ClientHome from './pages/ClientHome.jsx';
import ClientIntegrationsPage from './pages/ClientIntegrationsPage.jsx';
import SettlementsPage from './pages/SettlementsPage.jsx';
import SettlementViewPage from './pages/SettlementViewPage.jsx';
import DocumentViewPage from './pages/DocumentViewPage.jsx';
import InboxPage from './os/InboxPage.jsx';
import DigestsPage from './pages/DigestsPage.jsx';
import EngagePage from './pages/EngagePage.jsx';
import InventiveAskPage from './pages/InventiveAskPage.jsx';
import Logo from './components/Logo.jsx';
import RootErrorBoundary from './components/RootErrorBoundary.jsx';
import { DrillProvider } from './lib/DrillContext.jsx';
import { AuthProvider, useAuth } from './lib/auth.jsx';
import { ProfileProvider, useProfile } from './lib/profile.jsx';
import { ThemeProvider, useTheme } from './lib/theme.jsx';
import { useIsMobile } from './lib/useIsMobile.js';

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
  const canSwitch = isAdmin ? entities.length > 0 : entities.length > 1;
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
      <div style={{ flex: 1 }} />
      {/* Admin console: admin controls on the right. Client experience (client
          login OR admin acting as a client): just the Howler·Pulse badge — the
          account actions live in the sidebar's bottom-left profile menu. */}
      {isAdmin && !inClientView ? (
        // On the desktop Admin console these controls live in the left rail's
        // bottom profile menu, so drop them from the top bar there. Elsewhere
        // (Dashboards, editor) and on mobile, keep them in the top bar.
        (!isMobile && location.pathname === '/admin') ? null : (
        <>
          <Link to="/admin" style={navLink}>Admin</Link>
          <button onClick={toggle} title={theme === 'dark' ? 'Light mode' : 'Dark mode'} aria-label="Toggle theme" style={themeBtn}>{theme === 'dark' ? '☀️' : '🌙'}</button>
          {!isMobile && <UserBadge user={user} isAdmin={isAdmin} />}
          <button onClick={() => logout()} style={logoutBtn}>{isMobile ? 'Exit' : 'Log out'}</button>
        </>
        )
      ) : inClientView && (
        <button onClick={() => navigate('/')} title="Powered by Howler Pulse" style={{ display: 'flex', alignItems: 'center', gap: 7, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, opacity: 0.85 }}>
          <Logo size={22} radius={6} />
          {!isMobile && <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.2px', color: 'var(--muted)' }}>Howler&nbsp;:&nbsp;Pulse</span>}
        </button>
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
      <Avatar e={active} size={30} />
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

  if (loading) {
    return <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>Loading…</div>;
  }
  if (!user) return <LoginPage />;

  // An admin who has switched into one of their client accounts gets the real
  // client shell (scoped to that entity), not the admin console.
  const actingAsClient = isAdmin && mode === 'client' && !!activeEntityId;

  return (
    <BrowserRouter>
      <DrillProvider>
        <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
          <Header />
          <InboxNotifier entityId={mode === 'client' ? activeEntityId : undefined} />
          {isAdmin && !actingAsClient ? (
            <Routes>
              <Route path="/" element={<Navigate to="/admin" replace />} />
              <Route path="/dashboards" element={<HomePage />} />
              <Route path="/d/:id" element={<ViewPage />} />
              <Route path="/d/:id/edit" element={<EditorPage />} />
              <Route path="/clone" element={<ClonePage />} />
              <Route path="/admin" element={<AdminPage />} />
              {/* Preview the client experience without logging in as them. */}
              <Route element={<ClientLayout />}>
                <Route path="/preview" element={<ClientHome />} />
                <Route path="/suite/:suiteId/d/:id" element={<ViewPage />} />
                <Route path="/settlements" element={<SettlementsPage />} />
                <Route path="/settlements/:id" element={<SettlementViewPage />} />
                <Route path="/documents/:id" element={<DocumentViewPage />} />
                <Route path="/inbox" element={<InboxPage />} />
                <Route path="/digests" element={<DigestsPage />} />
                <Route path="/engage" element={<EngagePage />} />
                <Route path="/ask" element={<InventiveAskPage />} />
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
                <Route path="/settlements" element={<SettlementsPage />} />
                <Route path="/settlements/:id" element={<SettlementViewPage />} />
                <Route path="/documents/:id" element={<DocumentViewPage />} />
                <Route path="/inbox" element={<InboxPage />} />
                <Route path="/digests" element={<DigestsPage />} />
                <Route path="/engage" element={<EngagePage />} />
                <Route path="/ask" element={<InventiveAskPage />} />
                <Route path="/engage/:tab" element={<EngagePage />} />
                <Route path="/actions" element={<RedirectTo to="/engage/campaigns" />} />
                <Route path="/segments" element={<RedirectTo to="/engage/segments" />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          )}
        </div>
      </DrillProvider>
    </BrowserRouter>
  );
}

export default function App() {
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
