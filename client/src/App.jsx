import { useState, useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, Link, Navigate, useNavigate } from 'react-router-dom';
import HomePage from './pages/HomePage.jsx';
import ViewPage from './pages/ViewPage.jsx';
import EditorPage from './pages/EditorPage.jsx';
import ClonePage from './pages/ClonePage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import ClientLayout from './pages/ClientLayout.jsx';
import ClientHome from './pages/ClientHome.jsx';
import ClientIntegrationsPage from './pages/ClientIntegrationsPage.jsx';
import SettlementsPage from './pages/SettlementsPage.jsx';
import SettlementViewPage from './pages/SettlementViewPage.jsx';
import DocumentViewPage from './pages/DocumentViewPage.jsx';
import InboxPage from './os/InboxPage.jsx';
import DigestsPage from './pages/DigestsPage.jsx';
import ActionsPage from './pages/ActionsPage.jsx';
import Logo from './components/Logo.jsx';
import RootErrorBoundary from './components/RootErrorBoundary.jsx';
import { DrillProvider } from './lib/DrillContext.jsx';
import { AuthProvider, useAuth } from './lib/auth.jsx';
import { ProfileProvider, useProfile } from './lib/profile.jsx';
import { ThemeProvider, useTheme } from './lib/theme.jsx';
import { useIsMobile } from './lib/useIsMobile.js';

function Header() {
  const navigate = useNavigate();
  const { user, isAdmin, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const { active, entities, activeEntityId, setProfile } = useProfile();
  const isMobile = useIsMobile();
  // Clients lead with their OWN identity (active profile's logo + name) — and
  // that identity IS the profile switcher when the login holds several clients.
  // The Howler·Pulse platform badge sits on the right as the "powered by".
  // Admins keep the platform brand on the left + their header controls.
  const showClientIdentity = !isAdmin && active;
  const canSwitch = !isAdmin && entities.length > 1;
  return (
    <header style={{
      background: 'var(--frost)', backdropFilter: 'saturate(180%) blur(20px)', WebkitBackdropFilter: 'saturate(180%) blur(20px)',
      borderBottom: '1px solid var(--hairline)', padding: isMobile ? '0 14px' : '0 22px',
      height: 56, display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 12, flexShrink: 0, zIndex: 10,
    }}>
      {showClientIdentity ? (
        <ProfileIdentity
          active={active}
          entities={entities}
          activeEntityId={activeEntityId}
          canSwitch={canSwitch}
          onSwitch={(id) => { setProfile(id); navigate('/'); }}
          onHome={() => navigate('/')}
          isMobile={isMobile}
        />
      ) : (
        <>
          <div style={{ cursor: 'pointer', display: 'flex' }} onClick={() => navigate('/')}>
            <Logo size={30} radius={8} />
          </div>
          <Link to="/" style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.3px', textDecoration: 'none', color: 'var(--text)' }}>Howler&nbsp;:&nbsp;Pulse</Link>
        </>
      )}
      <div style={{ flex: 1 }} />
      {/* Clients get Integrations, theme and Log out in the sidebar's bottom-left
          profile menu — the header carries only the Howler·Pulse platform badge.
          Admin pages have no persistent sidebar, so admins keep the controls. */}
      {isAdmin ? (
        <>
          <Link to="/admin" style={navLink}>Admin</Link>
          <button onClick={toggle} title={theme === 'dark' ? 'Light mode' : 'Dark mode'} aria-label="Toggle theme" style={themeBtn}>{theme === 'dark' ? '☀️' : '🌙'}</button>
          {!isMobile && <UserBadge user={user} isAdmin={isAdmin} />}
          <button onClick={() => logout()} style={logoutBtn}>{isMobile ? 'Exit' : 'Log out'}</button>
        </>
      ) : showClientIdentity && (
        <button onClick={() => navigate('/')} title="Powered by Howler Pulse" style={{ display: 'flex', alignItems: 'center', gap: 7, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, opacity: 0.85 }}>
          <Logo size={22} radius={6} />
          {!isMobile && <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.2px', color: 'var(--muted)' }}>Howler&nbsp;:&nbsp;Pulse</span>}
        </button>
      )}
    </header>
  );
}

// The client identity in the top-left. With more than one profile it doubles as
// the profile switcher: click to drop a list of the other clients you can act
// as. Otherwise it's just a Home button.
function ProfileIdentity({ active, entities, activeEntityId, canSwitch, onSwitch, onHome, isMobile }) {
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
  const idRow = (
    <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <Avatar e={active} size={30} />
      <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.2px', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{active.name}</span>
    </span>
  );
  if (!canSwitch) {
    return <button onClick={onHome} style={identityBtn} title="Home">{idRow}</button>;
  }
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} style={identityBtn} title="Switch profile">
        {idRow}
        <span style={{ flexShrink: 0, fontSize: 11, color: 'var(--muted)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
      </button>
      {open && (
        <div className="modal-in" style={identityMenu}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', padding: '4px 10px 6px' }}>Switch profile</div>
          {entities.map((e) => {
            const on = e.id === activeEntityId;
            return (
              <button key={e.id} className="nav-row" onClick={() => { setOpen(false); if (!on) onSwitch(e.id); }}
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
const identityMenu = { position: 'absolute', top: 'calc(100% + 6px)', left: 0, minWidth: 220, zIndex: 71, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 12px 36px -8px rgba(0,0,0,0.28)', padding: 6, display: 'flex', flexDirection: 'column', gap: 2 };
const identityItem = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', border: 'none', cursor: 'pointer', padding: '8px 10px', borderRadius: 9, color: 'var(--text)' };
const navLink = { fontSize: 13, fontWeight: 600, color: 'var(--brand)', textDecoration: 'none' };
const logoutBtn = { fontSize: 12, fontWeight: 600, border: 'none', background: 'rgba(128,128,128,0.12)', color: 'var(--text)', borderRadius: 980, padding: '7px 14px', cursor: 'pointer' };
const themeBtn = { border: 'none', background: 'rgba(128,128,128,0.12)', borderRadius: 980, width: 30, height: 30, fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 };

function Shell() {
  const { user, loading, isAdmin } = useAuth();

  if (loading) {
    return <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>Loading…</div>;
  }
  if (!user) return <LoginPage />;

  return (
    <BrowserRouter>
      <DrillProvider>
        <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
          <Header />
          {isAdmin ? (
            <Routes>
              <Route path="/" element={<HomePage />} />
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
                <Route path="/actions" element={<ActionsPage />} />
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
                <Route path="/actions" element={<ActionsPage />} />
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
