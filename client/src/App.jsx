import { BrowserRouter, Routes, Route, Link, Navigate, useNavigate } from 'react-router-dom';
import HomePage from './pages/HomePage.jsx';
import ViewPage from './pages/ViewPage.jsx';
import EditorPage from './pages/EditorPage.jsx';
import ClonePage from './pages/ClonePage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import SuitesPage from './pages/SuitesPage.jsx';
import SuitePage from './pages/SuitePage.jsx';
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
      <div style={{ width: 30, height: 30, background: 'var(--brand)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, cursor: 'pointer' }} onClick={() => navigate('/')}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="white">
          <path d="M9 3v11.5a3.5 3.5 0 1 0 2 3.13V8h7V3H9zm-1.5 16a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM11 6V5h5v1h-5z" />
        </svg>
      </div>
      <Link to="/" style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.3px', textDecoration: 'none', color: 'var(--text)' }}>Howler</Link>
      {/* Secondary text only fits on tablet+ */}
      {!isMobile && <span style={{ fontSize: 13, color: 'var(--muted)', borderLeft: '1px solid #e0e0e0', paddingLeft: 12 }}>Analytics Studio</span>}
      <div style={{ flex: 1 }} />
      {isAdmin && <Link to="/admin" style={navLink}>Admin</Link>}
      {!isMobile && <span style={{ fontSize: 13, color: 'var(--muted)' }}>{user?.email}{isAdmin ? ' (admin)' : ''}</span>}
      <button onClick={() => logout()} style={logoutBtn}>{isMobile ? 'Exit' : 'Log out'}</button>
    </header>
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
          <Routes>
            {/* Admins land on the builder/home; clients land on their suites. */}
            <Route path="/" element={isAdmin ? <HomePage /> : <SuitesPage />} />
            <Route path="/suite/:suiteId" element={<SuitePage />} />
            <Route path="/suite/:suiteId/d/:id" element={<ViewPage />} />
            <Route path="/d/:id" element={<ViewPage />} />
            <Route path="/d/:id/edit" element={isAdmin ? <EditorPage /> : <Navigate to="/" replace />} />
            <Route path="/clone" element={isAdmin ? <ClonePage /> : <Navigate to="/" replace />} />
            <Route path="/admin" element={isAdmin ? <AdminPage /> : <Navigate to="/" replace />} />
          </Routes>
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
