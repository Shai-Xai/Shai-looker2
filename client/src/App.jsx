import { BrowserRouter, Routes, Route, Link, Navigate, useNavigate } from 'react-router-dom';
import HomePage from './pages/HomePage.jsx';
import ViewPage from './pages/ViewPage.jsx';
import EditorPage from './pages/EditorPage.jsx';
import ClonePage from './pages/ClonePage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import ClientLayout from './pages/ClientLayout.jsx';
import ClientHome from './pages/ClientHome.jsx';
import Logo from './components/Logo.jsx';
import { DrillProvider } from './lib/DrillContext.jsx';
import { AuthProvider, useAuth } from './lib/auth.jsx';
import { useIsMobile } from './lib/useIsMobile.js';

function Header() {
  const navigate = useNavigate();
  const { user, isAdmin, logout } = useAuth();
  const isMobile = useIsMobile();
  return (
    <header style={{
      background: 'rgba(255,255,255,0.72)', backdropFilter: 'saturate(180%) blur(20px)', WebkitBackdropFilter: 'saturate(180%) blur(20px)',
      borderBottom: '1px solid var(--hairline)', padding: isMobile ? '0 14px' : '0 22px',
      height: 56, display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 12, flexShrink: 0, zIndex: 10,
    }}>
      <div style={{ cursor: 'pointer', display: 'flex' }} onClick={() => navigate('/')}>
        <Logo size={30} radius={8} />
      </div>
      <Link to="/" style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.3px', textDecoration: 'none', color: 'var(--text)' }}>Howler&nbsp;:&nbsp;Pulse</Link>
      <div style={{ flex: 1 }} />
      {isAdmin && <Link to="/admin" style={navLink}>Admin</Link>}
      {!isMobile && <UserBadge user={user} isAdmin={isAdmin} />}
      <button onClick={() => logout()} style={logoutBtn}>{isMobile ? 'Exit' : 'Log out'}</button>
    </header>
  );
}

// Top-right identity: the client's logo + name (for client logins) and the
// signed-in email. Admins just show their email + an "admin" tag.
function UserBadge({ user, isAdmin }) {
  const client = !isAdmin ? (user?.entities || [])[0] : null;
  const extra = !isAdmin && (user?.entities || []).length > 1 ? ` +${user.entities.length - 1}` : '';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
      {client?.logo && <img src={client.logo} alt="" style={{ height: 26, maxWidth: 70, objectFit: 'contain' }} />}
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

const navLink = { fontSize: 13, fontWeight: 600, color: 'var(--brand)', textDecoration: 'none' };
const logoutBtn = { fontSize: 12, fontWeight: 600, border: 'none', background: 'rgba(0,0,0,0.05)', color: 'var(--text)', borderRadius: 980, padding: '7px 14px', cursor: 'pointer' };

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
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          ) : (
            // Clients get a persistent Suites → Sets → Dashboards sidebar.
            <Routes>
              <Route element={<ClientLayout />}>
                <Route path="/" element={<ClientHome />} />
                <Route path="/suite/:suiteId/d/:id" element={<ViewPage />} />
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
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
