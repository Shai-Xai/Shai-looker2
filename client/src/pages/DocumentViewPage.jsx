import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// In-app viewer for an uploaded invoice / document — same chrome as the
// settlement report (header, back, download) but renders the file inline
// instead of forcing a download. PDFs embed in an iframe; images show directly.
export default function DocumentViewPage() {
  const { id } = useParams();
  const isMobile = useIsMobile();
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setDoc(null); setError(null);
    api.getDocument(id).then(setDoc).catch((e) => setError(e.message));
  }, [id]);

  if (error) return <Centered error>Error: {error}</Centered>;
  if (!doc) return <Centered>Loading document…</Centered>;

  const fileUrl = `/api/documents/${doc.id}/file`;
  const isPdf = (doc.fileType || '').includes('pdf') || /\.pdf$/i.test(doc.fileName || '');
  const isImage = (doc.fileType || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(doc.fileName || '');

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ background: 'var(--frost)', backdropFilter: 'saturate(180%) blur(20px)', WebkitBackdropFilter: 'saturate(180%) blur(20px)', borderBottom: '1px solid var(--hairline)', padding: isMobile ? '12px 14px' : '14px 22px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Link to="/settlements" style={{ color: 'var(--muted)', fontSize: 13, textDecoration: 'none', flexShrink: 0 }}>← Settlements</Link>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>🧾</span>
            <h2 style={{ fontSize: isMobile ? 16 : 20, fontWeight: 700, letterSpacing: '-0.02em' }}>{doc.title}</h2>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {[doc.eventName, doc.fileName].filter(Boolean).join(' · ')}
          </div>
        </div>
        <a href={fileUrl} style={{ ...pillBtn, textDecoration: 'none' }} title="Download">⤓ {!isMobile && 'Download'}</a>
      </div>

      <div style={{ flex: 1, minHeight: 0, padding: isMobile ? 0 : 16, background: 'var(--bg)' }}>
        {isPdf ? (
          <iframe
            title={doc.title}
            src={`${fileUrl}?inline=1`}
            style={{ width: '100%', height: '100%', border: 'none', borderRadius: isMobile ? 0 : 12, background: '#fff', boxShadow: isMobile ? 'none' : 'var(--shadow-sm)' }}
          />
        ) : isImage ? (
          <div style={{ height: '100%', overflow: 'auto', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: 16 }}>
            <img src={`${fileUrl}?inline=1`} alt={doc.title} style={{ maxWidth: '100%', height: 'auto', borderRadius: 8, boxShadow: 'var(--shadow-sm)' }} />
          </div>
        ) : (
          <Centered>
            <div style={{ textAlign: 'center' }}>
              <p style={{ marginBottom: 12 }}>This file type can't be previewed in the browser.</p>
              <a href={fileUrl} style={{ ...pillBtn, textDecoration: 'none', display: 'inline-flex' }}>⤓ Download {doc.fileName}</a>
            </div>
          </Centered>
        )}
      </div>
    </div>
  );
}

const pillBtn = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 14px', background: 'rgba(128,128,128,0.15)', color: 'var(--text)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0 };

function Centered({ children, error }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
      <p style={{ fontSize: 15, color: error ? 'var(--error)' : 'var(--muted)' }}>{children}</p>
    </div>
  );
}
