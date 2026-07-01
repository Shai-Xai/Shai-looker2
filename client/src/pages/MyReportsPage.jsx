// Client workspace "Product" section — where a client tracks the bugs, ideas and
// improvements they've reported (and reviews shipped work). Its own left-nav item;
// new reports are still filed from the app-wide 💬 Report widget.
import HomeButton from '../components/HomeButton.jsx';
import MyReports from '../components/MyReports.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';

export default function MyReportsPage() {
  const isMobile = useIsMobile();
  return (
    <main style={{ flex: 1, padding: isMobile ? '20px 14px' : '32px 24px', maxWidth: 1080, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <HomeButton />
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>Product</h1>
      </div>
      <MyReports />
    </main>
  );
}
