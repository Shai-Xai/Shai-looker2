import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';
import TableTile from './tiles/TableTile.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useScope } from '../lib/ScopeContext.jsx';

// Slide-over panel showing the underlying rows behind a clicked value.
// If the value has multiple drill links, lets the user pick which one.
export default function DrillModal({ links, title, onClose }) {
  const isMobile = useIsMobile();
  const { setId } = useScope();
  const [selected, setSelected] = useState(links.length === 1 ? links[0] : null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    setError(null);
    setData(null);
    api.drill(selected.url, setId)
      .then((r) => setData(r.data))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [selected]);

  const rowCount = data?.data?.length ?? null;

  const panelStyle = isMobile
    ? { ...panel, width: '100%', paddingBottom: 'env(safe-area-inset-bottom)' }
    : panel;

  return (
    <div style={isMobile ? { ...overlay, justifyContent: 'stretch' } : overlay} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>Drill into</div>
            <div style={{ fontSize: 15, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title || 'Detail'}</div>
          </div>
          {selected && links.length > 1 && (
            <button style={backBtn} onClick={() => { setSelected(null); setData(null); }}>‹ Choose drill</button>
          )}
          <button style={isMobile ? { ...closeBtn, fontSize: 22, padding: '6px 10px' } : closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div style={body}>
          {!selected ? (
            <div style={{ padding: 4 }}>
              <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>Choose what to drill into:</p>
              {links.map((l, i) => (
                <button key={i} style={menuItem} onClick={() => setSelected(l)}>
                  {l.label || 'Show details'}
                </button>
              ))}
            </div>
          ) : loading ? (
            <Centered>Loading detail…</Centered>
          ) : error ? (
            <Centered error>⚠ {error}</Centered>
          ) : data ? (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              {rowCount != null && (
                <div style={{ fontSize: 12, color: 'var(--muted)', padding: '0 2px 8px' }}>
                  {rowCount} row{rowCount === 1 ? '' : 's'}
                </div>
              )}
              <div style={{ flex: 1, minHeight: 0, border: '1px solid #eee', borderRadius: 8, overflow: 'hidden' }}>
                <TableTile data={data} />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', justifyContent: 'flex-end', zIndex: 300 };
const panel = { width: 'min(820px, 92vw)', height: '100%', background: '#fff', boxShadow: '-4px 0 24px rgba(0,0,0,0.15)', display: 'flex', flexDirection: 'column' };
const header = { display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '1px solid #e0e0e0' };
const body = { flex: 1, minHeight: 0, padding: 16, display: 'flex', flexDirection: 'column' };
const closeBtn = { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 17, color: '#888' };
const backBtn = { border: '1.5px solid #e0e0e0', background: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, borderRadius: 6, padding: '6px 10px' };
const menuItem = { display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', marginBottom: 6, border: '1.5px solid #e0e0e0', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 };

function Centered({ children, error }) {
  return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: error ? 'var(--error)' : 'var(--muted)', fontSize: 13, padding: 20, textAlign: 'center' }}>{children}</div>;
}
