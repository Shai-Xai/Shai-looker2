import { brandPrimary, useBrandLogo } from '../lib/brand.js';
import { ANY_VALUE, ANY_VALUE_LABEL } from '../lib/filterConstants.js';

// ─── Branded PDF / print cover ──────────────────────────────────────────────
// A print-only header that rides on top of the dashboard when the user hits
// "Download PDF" (which calls window.print()). It carries the tenant's
// white-label branding (logo + brand colour), the dashboard/suite title, the
// active date range + filters, and a generated-on stamp — so a PDF handed to
// someone who isn't on Pulse reads as a proper, self-explanatory report.
//
// Hidden on screen (`.pdf-cover { display:none }`) and shown only under
// @media print — see index.css. Multi-tenant safe by construction: the brand
// and the underlying tile data are already the active tenant's (queries are
// force-scoped server-side), so an admin previewing a client exports THAT
// client's branded view, and a client exports their own.

// Turn the live filter map into a readable [{ label, value }] list, skipping
// unset filters. Locked filters (the client's own organiser/event scope) are
// included — they're exactly the context a reader needs. "Any value" is spelled
// out rather than shown as the raw sentinel.
export function activeFilterSummary(filters = [], values = {}) {
  const out = [];
  for (const f of filters) {
    const raw = values[f.name];
    if (raw == null || raw === '') continue;
    const value = raw === ANY_VALUE ? ANY_VALUE_LABEL : String(raw);
    out.push({ label: f.title || f.name, value });
  }
  return out;
}

// A tidy "15 Jul 2026, 14:32" stamp for the current moment.
function generatedStamp() {
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 16).replace('T', ' ');
  }
}

export default function DashboardPrintHeader({ title, suiteName, entityName, filters = [], values = {} }) {
  // Light logo (the PDF prints on white); falls back to the brand colour chip.
  const logo = useBrandLogo();
  const brand = brandPrimary();
  const chips = activeFilterSummary(filters, values);
  const tenant = entityName || suiteName || 'Howler';

  return (
    <div className="pdf-cover" aria-hidden="true">
      <div className="pdf-cover-accent" style={{ background: `linear-gradient(90deg, ${brand}, var(--brand-2, ${brand}))` }} />
      <div className="pdf-cover-top">
        {logo
          ? <img className="pdf-cover-logo" src={logo} alt="" />
          : <span className="pdf-cover-logo pdf-cover-logo--fallback" style={{ background: brand }}>{(tenant[0] || 'H').toUpperCase()}</span>}
        <div className="pdf-cover-id">
          <div className="pdf-cover-tenant">{tenant}</div>
          {suiteName && suiteName !== tenant && <div className="pdf-cover-suite">{suiteName}</div>}
        </div>
        <div className="pdf-cover-stamp">
          <div>Report generated</div>
          <div className="pdf-cover-stamp-when">{generatedStamp()}</div>
        </div>
      </div>
      <h1 className="pdf-cover-title">{title}</h1>
      {chips.length > 0 && (
        <div className="pdf-cover-filters">
          <span className="pdf-cover-filters-label">Filters applied</span>
          <div className="pdf-cover-chips">
            {chips.map((c, i) => (
              <span key={i} className="pdf-cover-chip">
                <b>{c.label}:</b> {c.value}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
