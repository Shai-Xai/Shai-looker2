import { createPortal } from 'react-dom';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useSheetDrag } from '../lib/useSheetDrag.js';

// Read-only "Inspect query" side panel / bottom sheet. Lets a viewer audit the
// exact parameters driving an embedded tile — its dimensions, measures and the
// filters (tile-baked + the dashboard filters currently in effect) — without
// leaving Pulse. Pulse owns the interface (no Looker embed), so the "query
// logic" a tile hides is its own Looker query definition + the field metadata
// Looker returned with the last result; we surface that verbatim rather than
// duplicating any logic.
//
// Dual-surface (one component, two audiences via `detailed`):
//   • detailed=true  → STAFF / internal debugging: raw Looker field names,
//     model + explore, exact filter expressions, sorts and row limit.
//   • detailed=false → CLIENT self-service: friendly labels grouped into
//     Dimensions / Measures / Filters, no LookML internals.
// Both are read-only and mobile-first (see /docs & PRODUCT_OVERVIEW_SALES.md).
export default function InspectQueryModal({ tile, data, filters, dashboardFields = [], detailed = false, onClose }) {
  const isMobile = useIsMobile();
  const drag = useSheetDrag(onClose);

  const q = tile.query || {};
  const pivotSet = new Set(q.pivots || []);
  // Prefer the field metadata Looker returned with the LAST result — it reflects
  // exactly what drove the currently displayed number. Fall back to the query's
  // raw field list (tile configured but not yet run / errored) so the panel still
  // has something to show.
  const dims = data?.fields?.dimensions?.length || data?.fields?.measures?.length
    ? (data.fields.dimensions || [])
    : queryFieldsAsMeta(q.fields, 'dimension');
  const measures = data?.fields?.measures || (data ? [] : queryFieldsAsMeta(q.fields, 'measure'));
  const tableCalcs = data?.fields?.table_calculations || [];

  // Effective filters (tile-baked + active dashboard filters), keyed by field.
  const filterEntries = Object.entries(filters || {}).filter(([, v]) => v != null && String(v).trim() !== '');
  const dashSet = new Set(dashboardFields || []);
  // Label lookup: every field Looker described, so a filter on a selected field
  // shows its friendly label. Filters on non-selected fields humanise the name.
  const labelByName = {};
  for (const f of [...dims, ...measures, ...tableCalcs]) labelByName[f.name] = f.label_short || f.label || f.name;

  const panelStyle = isMobile
    ? { ...panel, width: '100%', maxHeight: '92dvh', borderRadius: '18px 18px 0 0', paddingBottom: 'env(safe-area-inset-bottom)' }
    : panel;

  const node = (
    <div className="ai-overlay" style={isMobile ? { ...overlay, alignItems: 'flex-end', justifyContent: 'center' } : overlay} onClick={onClose}>
      <div
        className={isMobile ? 'ai-sheet' : 'ai-panel'}
        style={isMobile ? { ...panelStyle, ...drag.style } : panelStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {isMobile && <div className="sheet-grip" {...drag.handlers} style={{ marginTop: 8 }} />}
        <div style={header}>
          <span style={{ fontSize: 22, lineHeight: 1 }} aria-hidden>🔍</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>Inspect query</div>
            <div style={{ fontSize: 15, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tile.title || 'This tile'}</div>
          </div>
          <button style={isMobile ? { ...closeBtn, fontSize: 22, padding: '6px 10px' } : closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div style={body}>
          <Section title="Dimensions" hint="Attributes the data is broken down by" count={dims.length}>
            {dims.length
              ? dims.map((f) => <FieldRow key={f.name} field={f} detailed={detailed} pivot={pivotSet.has(f.name)} />)
              : <Empty>No dimensions — this tile isn't broken down by any attribute.</Empty>}
          </Section>

          <Section title="Measures" hint="Metrics & calculations applied" count={measures.length}>
            {measures.length
              ? measures.map((f) => <FieldRow key={f.name} field={f} detailed={detailed} measure />)
              : <Empty>No measures on this tile.</Empty>}
          </Section>

          {tableCalcs.length > 0 && (
            <Section title="Table calculations" hint="Derived columns computed on the result" count={tableCalcs.length}>
              {tableCalcs.map((f) => <FieldRow key={f.name} field={f} detailed={detailed} measure />)}
            </Section>
          )}

          <Section title="Filters" hint="Global & tile-specific filters affecting the number" count={filterEntries.length}>
            {filterEntries.length
              ? filterEntries.map(([field, value]) => (
                  <FilterRow
                    key={field}
                    field={field}
                    value={value}
                    label={labelByName[field] || humaniseField(field)}
                    source={dashSet.has(field) ? 'Dashboard' : 'Tile'}
                    detailed={detailed}
                  />
                ))
              : <Empty>No filters are narrowing this tile.</Empty>}
          </Section>

          {detailed && (
            <Section title="Source" hint="Looker query — internal (staff only)">
              <MetaRow label="Model" value={q.model} />
              <MetaRow label="Explore" value={q.view} />
              {q.sorts?.length > 0 && <MetaRow label="Sorts" value={q.sorts.join(', ')} />}
              {q.limit && <MetaRow label="Row limit" value={String(q.limit)} />}
              {(q.pivots?.length || 0) > 0 && <MetaRow label="Pivots" value={q.pivots.join(', ')} />}
            </Section>
          )}
        </div>

        <div style={{ padding: '10px 18px 14px', fontSize: 11, color: 'var(--muted)', borderTop: '1px solid var(--hairline)' }}>
          Read-only. Reflects the parameters driving the number shown now, including any active filters.
          {detailed ? ' Staff view — includes raw query internals.' : ''}
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

// Turn a bare query field list into pseudo-metadata when we have no live result
// to describe them. Heuristic split: a measure name usually ends in a
// count/sum/total-ish word; everything else reads as a dimension. Only used as a
// fallback — a run tile uses Looker's real dimension/measure classification.
function queryFieldsAsMeta(fields, kind) {
  const isMeasure = (n) => /(count|sum|total|average|avg|median|min|max|number|amount|revenue|rate|percent)$/i.test(String(n).split('.').pop() || '');
  return (fields || [])
    .filter((n) => (kind === 'measure' ? isMeasure(n) : !isMeasure(n)))
    .map((name) => ({ name, label: humaniseField(name) }));
}

// "orders.created_date" → "Orders · Created date". Best-effort humanising for
// fields Looker didn't hand us a label for (fallback path only).
function humaniseField(name) {
  const cap = (s) => s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase());
  const parts = String(name).split('.');
  if (parts.length === 2) return `${cap(parts[0])} · ${cap(parts[1])}`;
  return cap(name);
}

function Section({ title, hint, count, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{title}</h3>
        {count != null && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', background: 'var(--elevated)', borderRadius: 980, padding: '1px 8px' }}>{count}</span>}
      </div>
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.4 }}>{hint}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </div>
  );
}

function FieldRow({ field, detailed, pivot, measure }) {
  return (
    <div style={rowCard}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{field.label_short || field.label || humaniseField(field.name)}</span>
        {pivot && <Chip tone="brand">pivot</Chip>}
        {measure && field.value_format && <Chip>{field.value_format}</Chip>}
      </div>
      {detailed && (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3, fontFamily: 'var(--mono, ui-monospace, monospace)', wordBreak: 'break-all' }}>
          {field.name}{field.type ? ` · ${field.type}` : ''}
        </div>
      )}
      {field.description && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.4 }}>{field.description}</div>}
    </div>
  );
}

function FilterRow({ field, value, label, source, detailed }) {
  return (
    <div style={rowCard}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{label}</span>
        <Chip tone={source === 'Dashboard' ? 'brand' : undefined}>{source}</Chip>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text)', marginTop: 4, fontFamily: 'var(--mono, ui-monospace, monospace)', wordBreak: 'break-word' }}>
        {String(value)}
      </div>
      {detailed && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3, fontFamily: 'var(--mono, ui-monospace, monospace)', wordBreak: 'break-all' }}>{field}</div>}
    </div>
  );
}

function MetaRow({ label, value }) {
  if (!value) return null;
  return (
    <div style={{ ...rowCard, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
      <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 12.5, color: 'var(--text)', fontFamily: 'var(--mono, ui-monospace, monospace)', wordBreak: 'break-all', textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function Chip({ children, tone }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.02em', textTransform: 'uppercase',
      padding: '1px 7px', borderRadius: 980, lineHeight: 1.6,
      color: tone === 'brand' ? 'var(--brand)' : 'var(--muted)',
      background: tone === 'brand' ? 'var(--brand-tint, rgba(120,80,220,0.12))' : 'var(--elevated)',
      border: '1px solid var(--hairline)',
    }}>{children}</span>
  );
}

function Empty({ children }) {
  return <div style={{ fontSize: 12.5, color: 'var(--muted)', fontStyle: 'italic', lineHeight: 1.5 }}>{children}</div>;
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', justifyContent: 'flex-end', zIndex: 400 };
const panel = { width: 'min(440px, 92vw)', height: '100%', background: 'var(--card)', boxShadow: '-4px 0 24px rgba(0,0,0,0.15)', display: 'flex', flexDirection: 'column' };
const header = { display: 'flex', alignItems: 'center', gap: 12, padding: '16px 18px', borderBottom: '1px solid var(--border)' };
const body = { flex: 1, minHeight: 0, overflowY: 'auto', padding: 18 };
const rowCard = { border: '1px solid var(--hairline)', borderRadius: 10, padding: '9px 12px', background: 'var(--elevated)' };
const closeBtn = { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 17, color: '#888' };
