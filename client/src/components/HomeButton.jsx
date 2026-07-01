import { Link } from 'react-router-dom';

// The same round Home affordance the dashboard view uses — reused on the Engage
// hub and the workspace pages (settlements, inbox, digests…) so getting back
// home is one consistent tap everywhere.
export default function HomeButton({ to = '/', style }) {
  return (
    <Link to={to} title="Home" aria-label="Home" className="btn-key" style={{ ...homeBtn, ...style }}>
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 10.5 12 3l9 7.5" />
        <path d="M5 9.5V21h5.5v-6h3v6H19V9.5" />
      </svg>
    </Link>
  );
}

const homeBtn = { flexShrink: 0, width: 40, height: 40, borderRadius: '50%', background: 'rgba(128,128,128,0.15)', color: 'var(--text)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' };
