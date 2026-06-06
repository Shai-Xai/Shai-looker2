import { BrowserRouter, Routes, Route, Link, Navigate, useNavigate } from 'react-router-dom';
import HomePage from './pages/HomePage.jsx';
import ViewPage from './pages/ViewPage.jsx';
import EditorPage from './pages/EditorPage.jsx';
import ClonePage from './pages/ClonePage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import { DrillProvider } from './lib/DrillContext.jsx';
import { AuthProvider, useAuth } from './lib/auth.jsx';

function Header() {
  const navigate = useNavigate();
  const { user, isAdmin, logout } = useAuth();
  return (
    <header style={{
      background: '#fff', borderBottom: '1px solid #e0e0e0', padding: '0 24px',
      height: 60, display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
    }}>
      <div style={{ width: 30, height: 30, background: 'var(--brand)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, cursor: 'pointer' }} onClick={() => navigate('/')}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="white">
          <path d="M9 3v11.5a3.5 3.5 0 1 0 2 3.13V8h7V3H9zm-1.5 16a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM11 6V5h5v1h-5z" />
        </svg>
      </div>
      <Link to="/" style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.3px', textDecoration: 'none', color: 'var(--text)' }}>Howler</Link>
      <span style={{ fontSize: 13, color: 'var(--muted)', borderLeft: '1px solid #e0e0e0', paddingLeft: 12 }}>Analytics Studio</span>
      <div style={{ flex: 1 }} />
      {isAdmin && <Link to="/admin" style={navLink}>Admin</Link>}
      <span style={{ fontSize: 13, color: 'var(--muted)' }}>{user?.email}{isAdmin ? ' (admin)' : ''}</span>
      <button onClick={() => logout()} style={logoutBtn}>Log out</button>
    </header>
  );
}

const navLink = { fontSize: 13, fontWeight: 600, color: 'var(--brand)', textDecoration: 'none' };
const logoutBtn = { fontSize: 12, fontWeight: 600, border: '1.5px solid #e0e0e0', background: '#fff', borderRadius: 7, padding: '6px 12px', cursor: 'pointer' };

function Shell() {
  const { user, loading, isAdmin } = useAuth();

  if (loading) {
    return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>Loading…</div>;
  }
  if (!user) return <LoginPage />;

  return (
    <BrowserRouter>
      <DrillProvider>
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
          <Header />
          <Routes>
            <Route path="/" element={<HomePage />} />
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
