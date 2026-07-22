// Client workspace "Product" section, two tabs:
//   ✨ What's in Pulse — the client-facing feature matrix (grid of section tiles;
//     see WhatsInPulse), fed by the same catalogue as the public sales site.
//   💬 Your requests — the bugs, ideas and improvements they've reported (and
//     review of shipped work). New reports are also filed from the app-wide
//     💬 Report widget, and the matrix's "Interested?" CTAs land here too.
import { useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import MyReports from '../components/MyReports.jsx';
import WhatsInPulse from '../components/WhatsInPulse.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';

const TABS = [['matrix', "✨ What's in Pulse"], ['requests', '💬 Your requests']];

export default function MyReportsPage() {
  const isMobile = useIsMobile();
  const [tab, setTab] = useState('matrix');
  return (
    <main style={{ flex: 1, padding: isMobile ? '20px 14px' : '32px 24px', maxWidth: 1080, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
      <PageHeader title="Product" />
      <div style={{ display: 'flex', background: 'rgba(128,128,128,0.14)', borderRadius: 12, padding: 3, marginBottom: 18, maxWidth: 440 }}>
        {TABS.map(([key, label]) => (
          <button
            key={key} onClick={() => setTab(key)}
            style={{
              flex: 1, minHeight: 40, padding: '9px 4px', borderRadius: 9, border: 'none', cursor: 'pointer',
              fontSize: 13.5, fontWeight: 600, fontFamily: 'inherit', letterSpacing: 'inherit',
              background: tab === key ? 'var(--card)' : 'transparent',
              color: tab === key ? 'var(--text)' : 'var(--muted-2, var(--muted))',
              boxShadow: tab === key ? 'var(--shadow-sm)' : 'none',
            }}
          >{label}</button>
        ))}
      </div>
      {tab === 'matrix' ? <WhatsInPulse /> : <MyReports />}
    </main>
  );
}
