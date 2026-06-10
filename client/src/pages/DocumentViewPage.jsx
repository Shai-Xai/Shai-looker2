import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useCountUp } from '../lib/useCountUp.js';
import { fmtR, fmtQty } from '../lib/money.js';

// In-app viewer for an uploaded invoice / document. Extracted Howler invoices
// render as an interactive view (KPIs, line items, payment details) with the
// original PDF embedded underneath; files without extracted data render
// inline as-is (PDF iframe / image), with a download fallback for the rest.
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

  const d = doc.data || {};
  const interactive = !!(d.items?.length || d.total != null);
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
            {[doc.eventName, d.meta?.invoiceNumber && `Nº ${d.meta.invoiceNumber}`, d.meta?.date].filter(Boolean).join(' · ') || doc.fileName}
          </div>
        </div>
        <a href={fileUrl} style={{ ...pillBtn, textDecoration: 'none' }} title="Download">⤓ {!isMobile && 'Download'}</a>
      </div>

      {interactive ? (
        <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: isMobile ? 12 : 22 }}>
          <div style={{ maxWidth: 880, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: isMobile ? 12 : 16 }}>

            {/* KPI strip */}
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: isMobile ? 10 : 14 }}>
              <Kpi label="Total due" money={d.total} highlight delay={0} />
              <Kpi label="Subtotal (excl VAT)" money={d.subtotal} delay={70} />
              <Kpi label="VAT" money={d.vatTotal} delay={140} />
              <Kpi label="Due date" text={d.meta?.dueDate || '—'} delay={210} />
            </div>

            {/* From / To */}
            {(d.meta?.from || d.meta?.to) && (
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: isMobile ? 10 : 14 }}>
                {d.meta?.from && <Party label="From" value={d.meta.from} extra={d.meta?.vatNumber && `VAT ${d.meta.vatNumber}`} />}
                {d.meta?.to && <Party label="Billed to" value={d.meta.to} extra={d.meta?.reference && `Ref ${d.meta.reference}`} />}
              </div>
            )}

            {/* Line items */}
            <Card title="Line items">
              <div style={{ overflowX: 'auto' }}>
                <table style={tbl}>
                  <thead>
                    <tr>
                      {!isMobile && <th style={th}>Code</th>}
                      <th style={th}>Description</th>
                      <th style={{ ...th, textAlign: 'right' }}>Qty</th>
                      {!isMobile && <th style={{ ...th, textAlign: 'right' }}>Unit price</th>}
                      <th style={{ ...th, textAlign: 'right' }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(d.items || []).map((r, i) => (
                      <tr key={i} style={{ background: i % 2 ? 'var(--row-stripe)' : 'transparent' }}>
                        {!isMobile && <td style={{ ...td, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{r.code}</td>}
                        <td style={td}>{r.desc}</td>
                        <td style={{ ...td, ...num }}>{fmtQty(r.qty)}</td>
                        {!isMobile && <td style={{ ...td, ...num }}>{r.unitPrice != null ? fmtR(r.unitPrice) : ''}</td>}
                        <td style={{ ...td, ...num, fontWeight: 600, color: r.total < 0 ? 'var(--error)' : 'var(--text)' }}>{fmtR(r.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    {d.subtotal != null && (
                      <tr style={{ borderTop: '2px solid var(--hairline)' }}>
                        <td style={{ ...td, fontWeight: 600 }} colSpan={isMobile ? 2 : 4}>Subtotal</td>
                        <td style={{ ...td, ...num, fontWeight: 600 }}>{fmtR(d.subtotal)}</td>
                      </tr>
                    )}
                    {d.vatTotal != null && d.vatTotal !== 0 && (
                      <tr>
                        <td style={{ ...td, fontWeight: 600 }} colSpan={isMobile ? 2 : 4}>VAT</td>
                        <td style={{ ...td, ...num, fontWeight: 600 }}>{fmtR(d.vatTotal)}</td>
                      </tr>
                    )}
                    <tr>
                      <td style={{ ...td, fontWeight: 800, fontSize: 13.5 }} colSpan={isMobile ? 2 : 4}>Total due</td>
                      <td style={{ ...td, ...num, fontWeight: 800, fontSize: 13.5, color: '#2da44e' }}>{fmtR(d.total)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Card>

            {/* Payment details / notes */}
            {(d.paymentDetails || d.notes) && (
              <Card title="Payment details">
                {d.paymentDetails && <p style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', color: 'var(--text)' }}>{d.paymentDetails}</p>}
                {d.notes && <p style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', color: 'var(--muted)', marginTop: d.paymentDetails ? 8 : 0 }}>{d.notes}</p>}
              </Card>
            )}

            {/* Original document */}
            {isPdf && <OriginalDoc fileUrl={fileUrl} title={doc.title} />}

            <p style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', padding: '4px 0 14px' }}>
              Generated from the uploaded invoice. The PDF download is the authoritative document.
            </p>
          </div>
        </div>
      ) : (
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
      )}
    </div>
  );
}

function Kpi({ label, money, text, highlight, delay }) {
  const counted = useCountUp(money != null ? fmtR(money) : '—');
  const display = text !== undefined ? text : counted;
  return (
    <div className="tile-enter" style={{
      animationDelay: `${delay}ms`,
      background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-sm)', padding: '14px 16px',
      ...(highlight ? { borderColor: 'rgba(52,199,89,0.5)', background: 'linear-gradient(135deg, rgba(52,199,89,0.10), transparent 70%) var(--tile-bg, var(--card))' } : null),
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: text !== undefined ? 'clamp(13px, 1.8vw, 18px)' : 'clamp(15px, 2.1vw, 24px)', fontWeight: 800, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: highlight ? '#2da44e' : 'var(--text)' }}>{display}</div>
    </div>
  );
}

function Party({ label, value, extra }) {
  return (
    <Card title={label}>
      <p style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', color: 'var(--text)' }}>{value}</p>
      {extra && <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{extra}</p>}
    </Card>
  );
}

function Card({ title, children }) {
  return (
    <div className="howler-tile" style={{ background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-sm)', padding: '14px 16px' }}>
      <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '-0.01em', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

// Collapsible embed of the source PDF below the interactive view.
function OriginalDoc({ fileUrl, title }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="howler-tile" style={{ background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
      <button onClick={() => setOpen((v) => !v)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text)', textAlign: 'left' }}>
        <span className="nav-caret" style={{ fontSize: 10, color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }}>▶</span>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Original document</span>
      </button>
      {open && (
        <iframe title={`${title} (original)`} src={`${fileUrl}?inline=1`} style={{ width: '100%', height: 640, border: 'none', borderTop: '1px solid var(--hairline)', background: '#fff' }} />
      )}
    </div>
  );
}

const pillBtn = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 14px', background: 'rgba(128,128,128,0.15)', color: 'var(--text)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0 };
const tbl = { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 };
const th = { textAlign: 'left', padding: '7px 9px', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', borderBottom: '1px solid var(--hairline)', whiteSpace: 'nowrap' };
const td = { padding: '7px 9px', color: 'var(--text)', verticalAlign: 'top' };
const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

function Centered({ children, error }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
      <p style={{ fontSize: 15, color: error ? 'var(--error)' : 'var(--muted)' }}>{children}</p>
    </div>
  );
}
