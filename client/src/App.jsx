import { BrowserRouter, Routes, Route, Link, useNavigate } from 'react-router-dom';
import ClonePage from './pages/ClonePage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';

function Header() {
  const navigate = useNavigate();
  return (
    <header style={{
      background: '#fff',
      borderBottom: '1px solid #e0e0e0',
      padding: '0 32px',
      height: 64,
      display: 'flex',
      alignItems: 'center',
      gap: 12,
    }}>
      <div style={{
        width: 32, height: 32,
        background: 'var(--brand)',
        borderRadius: 8,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, cursor: 'pointer',
      }} onClick={() => navigate('/')}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
          <path d="M9 3v11.5a3.5 3.5 0 1 0 2 3.13V8h7V3H9zm-1.5 16a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM11 6V5h5v1h-5z"/>
        </svg>
      </div>
      <Link to="/" style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.3px', textDecoration: 'none', color: 'var(--text)' }}>
        Howler
      </Link>
      <span style={{ fontSize: 13, color: 'var(--muted)', borderLeft: '1px solid #e0e0e0', paddingLeft: 12, marginLeft: 4 }}>
        Analytics
      </span>
    </header>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
        <Header />
        <Routes>
          <Route path="/" element={<ClonePage />} />
          <Route path="/view/:dashboardId" element={<DashboardPage />} />
        </Routes>
        <footer style={{ textAlign: 'center', padding: 20, fontSize: 12, color: 'var(--muted)' }}>
          Howler Event Management Platform — Internal Tools
        </footer>
      </div>
    </BrowserRouter>
  );
}
